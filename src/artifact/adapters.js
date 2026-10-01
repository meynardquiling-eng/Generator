// Adapters that connect the core drill service to the Artifact runtime:
//   db     -> store       (shared trainer database)
//   sample -> llm         (Claude generates scenarios as the viewing trainer)
//   mcp    -> bridge      (Google Drive folder shared with the Apps Script Form Bridge)
//   mcp    -> slack       (CSQ channel history, for trainer-approved snippets)

var DRIVE = 'Google Drive';
var SLACK = 'Slack';

// The db delivers frozen documents; the drill service edits what it reads, so every
// read returns a private copy.
function makeDbStore(db) {
  return {
    async get(coll, id) {
      var snap = await db.collection(coll).doc(id).get();
      return snap.exists ? deepClone(snap.data()) : null;
    },
    async list(coll, where) {
      var q = db.collection(coll);
      if (where) q = q.where(where[0], '==', where[1]);
      var snap = await q.limit(1000).get();
      return snap.docs.map(function (d) { return deepClone(d.data()); });
    },
    async put(coll, id, obj) {
      await db.collection(coll).doc(id).set(JSON.parse(JSON.stringify(obj)));
    },
    async remove(coll, id) {
      await db.collection(coll).doc(id).delete();
    },
    async lease(key, holder, ttlMs) {
      var r = await db.collection('locks').doc(key).acquire({ holder: holder, ttlMs: ttlMs });
      return !!r.acquired;
    }
  };
}

function makeSampleLlm(sample) {
  return {
    async generateJson(req) {
      var prompt = req.system + '\n\n' + req.user + '\n\n' + describeSchemaForPrompt(req.schema);
      return sample.json(prompt, { modelTier: 'complex', cache: false });
    }
  };
}

function b64ToUtf8(b64) {
  var bin = atob(String(b64).replace(/\s+/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// The Drive connector's download result shape is not documented; accept the forms
// it can reasonably take (parsed JSON, raw text, base64 text, MCP content blocks).
function decodeDriveJson(result) {
  var candidates = [];
  var p = result ? result.payload : null;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    if (p.drillId || p.sections || p.parts || p.kind) return p;
    ['content', 'base64Content', 'data', 'fileContent', 'text', 'body'].forEach(function (k) {
      if (typeof p[k] === 'string') candidates.push(p[k]);
    });
  } else if (typeof p === 'string') {
    candidates.push(p);
  }
  ((result && result.content) || []).forEach(function (b) {
    if (b.type === 'text' && typeof b.text === 'string') candidates.push(b.text);
    if (b.type === 'resource' && b.resource) {
      if (typeof b.resource.text === 'string') candidates.push(b.resource.text);
      if (typeof b.resource.blob === 'string') candidates.push(b.resource.blob);
    }
  });
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i].trim();
    try { return JSON.parse(c); } catch (e) { /* not raw JSON */ }
    try { return JSON.parse(b64ToUtf8(c)); } catch (e) { /* not base64 JSON */ }
  }
  throw ServiceError('DRIVE_READ', 'Google Drive returned the file in a shape this dashboard could not read.');
}

function makeDriveBridge(mcp) {
  async function findFile(folderId, title) {
    var res = await mcp.callTool(DRIVE, 'search_files', {
      query: "parentId = '" + folderId.replace(/'/g, "\\'") + "' and title = '" + title.replace(/'/g, "\\'") + "'",
      excludeContentSnippets: true, pageSize: 5
    }, { cache: false });
    var files = (res.payload && res.payload.files) || [];
    return files.filter(function (f) { return f.title === title; })[0] || null;
  }
  async function readJson(folderId, title) {
    var f = await findFile(folderId, title);
    if (!f) return null;
    var res = await mcp.callTool(DRIVE, 'download_file_content', { fileId: f.id }, { cache: false });
    return decodeDriveJson(res);
  }
  async function writeNew(folderId, title, obj) {
    var res = await mcp.callTool(DRIVE, 'create_file', {
      title: title, parentId: folderId, textContent: JSON.stringify(obj),
      contentMimeType: 'application/json', disableConversionToGoogleType: true
    });
    return res.payload || {};
  }
  return {
    async requestForm(folderId, drillId, spec) {
      var title = 'drillform-request__' + drillId + '__' + spec.specHash + '.json';
      var existing = await findFile(folderId, title);
      if (existing) return { fileId: existing.id, reused: true };
      var created = await writeNew(folderId, title, { kind: 'FORM_REQUEST', drillId: drillId, specHash: spec.specHash, requestedAt: new Date().toISOString(), spec: spec });
      return { fileId: created.id || null, reused: false };
    },
    getFormResult: function (folderId, drillId) { return readJson(folderId, 'drillform-result__' + drillId + '.json'); },
    getResponses: function (folderId, drillId) { return readJson(folderId, 'drillform-responses__' + drillId + '.json'); },
    // One request per key (the doc's last-edit time, or "now" for a manual refresh).
    async requestSourceExport(folderId, docId, key) {
      var title = 'drill-sources-request__' + (key || Date.now()) + '.json';
      if (await findFile(folderId, title)) return { requested: true, reused: true };
      await writeNew(folderId, title, { kind: 'SOURCE_REQUEST', docId: docId, requestedAt: new Date().toISOString() });
      return { requested: true };
    },
    getSourceIndex: function (folderId) { return readJson(folderId, 'drill-sources__index.json'); },
    async getDocModifiedTime(docId) {
      var res = await mcp.callTool(DRIVE, 'get_file_metadata', { fileId: docId, excludeContentSnippets: true }, { cache: false });
      return (res.payload && res.payload.modifiedTime) || null;
    },
    getBridgeStatus: function (folderId) { return readJson(folderId, 'drill-bridge__status.json'); },
    async getSourceExport(folderId) {
      var index = await readJson(folderId, 'drill-sources__index.json');
      if (!index) return null;
      var sections = [];
      for (var i = 0; i < (index.parts || []).length; i++) {
        var part = await readJson(folderId, index.parts[i]);
        if (!part) throw ServiceError('DRIVE_READ', 'Source export part ' + index.parts[i] + ' is missing. Request a fresh export.');
        sections = sections.concat(part.sections || []);
      }
      return { generatedAt: index.generatedAt, docId: index.docId, docTitle: index.docTitle, sections: sections };
    }
  };
}

function makeSlackReader(mcp) {
  return {
    // Up to 3 pages (300 messages) from the last `days` days.
    async readChannel(channelId, opts) {
      var days = (opts && opts.days) || 45;
      var oldest = String(Math.floor(Date.now() / 1000 - days * 86400));
      var cursor = null, messages = [];
      for (var page = 0; page < 3; page++) {
        var input = { channel_id: channelId, limit: 100, oldest: oldest, response_format: 'detailed' };
        if (cursor) input.cursor = cursor;
        var res = await mcp.callTool(SLACK, 'slack_read_channel', input, { cache: false });
        messages = messages.concat(parseSlackChannelText(slackPayloadText(res.payload), channelId));
        var info = res.payload && res.payload.pagination_info;
        var m = /cursor:\s*`([^`]+)`/.exec(String(info || ''));
        if (!m) break;
        cursor = m[1];
      }
      return messages;
    },
    async searchChannels(term) {
      var res = await mcp.callTool(SLACK, 'slack_search_channels', { keywords: [term], natural_language_query: term + ' channels', response_format: 'concise', limit: 20 }, { cache: false });
      var text = typeof res.payload === 'string' ? res.payload : (res.payload && res.payload.results) || '';
      var out = [];
      String(text).split('\n').forEach(function (line) {
        var m = /#([\w-]+)\s+\((C[A-Z0-9]+)\)/.exec(line);
        if (m) out.push({ name: m[1], id: m[2] });
      });
      return out;
    }
  };
}

// Plain-language messages for each failure family, so the trainer knows the fix.
function errorText(e) {
  if (!e) return 'Something failed without an error message.';
  var server = e.server ? e.server : 'the connector';
  switch (e.code) {
    case 'server_not_connected': return 'Add ' + server + ' in claude.ai Settings → Connectors, then reload this page.';
    case 'needs_reauth': return 'Reconnect ' + server + ' in claude.ai Settings → Connectors.';
    case 'not_in_manifest': return server + ' is turned off for this page. Allow it from the page’s connector settings to use this feature.';
    case 'selection_required': return 'Choose which ' + server + ' account this page should use (claude.ai will prompt you).';
    case 'blocked_by_policy': case 'approval_required': return 'Your organization’s policy blocks this ' + server + ' action.';
    case 'server_unavailable': return server + ' did not answer. Try again in a moment.';
    case 'tool_error': return server + ' reported an error: ' + e.message;
    case 'not_granted': case 'sampling_disabled': return 'Claude is not allowed for this page, so scenarios cannot be generated here. You can still write scenarios manually.';
    case 'rate_limited': return 'Claude usage limit reached for now. Try again later.';
    case 'refused': return 'Claude declined this request. Change the trainer hint or regenerate.';
    case 'invalid_json': return 'Claude’s answer was not valid JSON. Try generating again.';
    case 'invalid_argument': return 'The database refused the write (you may have view-only access): ' + e.message;
    case 'quota_exceeded': return 'The dashboard database is full: ' + e.message;
    default: return e.message || String(e);
  }
}
