// Parse the Slack connector's channel history text into candidate snippets. The
// connector returns readable text, not structured messages, so this is deliberately
// forgiving; nothing becomes a source until a trainer approves it.
//
// Expected line shape for a message header:  "Author Name:  [2026-08-03 01:59:17 CDT]"
// followed by the message body on the next lines.

var SLACK_HEADER_RE = /^(.*?):?\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [A-Z]{2,5})?)\]\s*(.*)$/;
// "detailed" format: === Message from Jane Doe <jane@x.com> (U123) at 2026-08-17 19:20:53 CDT ===
var SLACK_DETAILED_RE = /^=== Message from (.+?)(?: <[^>]*>)?(?: \([A-Z0-9]+\))? at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [A-Z]{2,5})?) ===\s*$/;
var SLACK_SLACK_TS_RE = /^Message TS:\s*([0-9.]+)\s*$/;
var SLACK_THREAD_RE = /^Thread:\s*(\d+)\s+repl/;

// Version of the parser that produced a stored channel pull; a different version re-pulls.
var SLACK_PARSER_VERSION = 2;

function parseSlackChannelText(text, channelId) {
  var lines = String(text || '').split(/\r?\n/);
  var messages = [];
  var current = null;
  lines.forEach(function (line) {
    var d = SLACK_DETAILED_RE.exec(line);
    var m = d ? null : SLACK_HEADER_RE.exec(line);
    if (d || m) {
      if (current) messages.push(current);
      current = d
        ? { channelId: channelId, author: d[1].trim(), postedAt: d[2], ts: d[2], text: '', replyCount: 0 }
        : { channelId: channelId, author: m[1].replace(/^[-*\s]+/, '').trim(), postedAt: m[2], ts: m[2], text: m[3] ? m[3].trim() : '', replyCount: 0 };
      return;
    }
    if (!current) return;
    var t = SLACK_SLACK_TS_RE.exec(line);
    if (t) { current.ts = t[1]; return; }
    var th = SLACK_THREAD_RE.exec(line);
    if (th) { current.replyCount = parseInt(th[1], 10); return; }
    current.text = (current.text ? current.text + '\n' : '') + line;
  });
  if (current) messages.push(current);
  return messages.map(function (msg) {
    msg.text = msg.text.trim();
    return msg;
  }).filter(function (msg) { return msg.text.length > 0; });
}

// Thread format: "=== THREAD PARENT MESSAGE ===", then "--- Reply 1 of 2 ---" blocks with
// From:/Time:/Message TS: lines followed by the body.
function parseSlackThreadText(text) {
  var replies = [];
  var parts = String(text || '').split(/^--- Reply \d+ of \d+ ---\s*$/m);
  parts.slice(1).forEach(function (block) {
    var author = '', postedAt = '', body = [];
    block.split(/\r?\n/).forEach(function (line) {
      var f = /^From:\s*(.+?)(?: <[^>]*>)?(?: \([A-Z0-9]+\))?\s*$/.exec(line);
      if (f && !author) { author = f[1].trim(); return; }
      var tm = /^Time:\s*(.+)$/.exec(line);
      if (tm && !postedAt) { postedAt = tm[1].trim(); return; }
      if (SLACK_SLACK_TS_RE.test(line)) return;
      body.push(line);
    });
    var t = body.join('\n').trim();
    if (t) replies.push({ author: author, postedAt: postedAt, text: t });
  });
  return replies;
}

// Readable text without Slack markup, email addresses or customer/job/CP record numbers.
function cleanSlackText(s) {
  return String(s || '')
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@someone')
    .replace(/<(?:https?|mailto):[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b(C|J|CP)\s?#?\s?\d{5,}\b/g, '$1 [id]')
    .replace(/\(J \d+\)/g, '(J [id])')
    .replace(/\\\//g, '/')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Accepts whatever the connector returned (payload object or text) and finds the text.
function slackPayloadText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.messages === 'string') return payload.messages;
  if (Array.isArray(payload.messages)) {
    return payload.messages.map(function (m) {
      return (m.user || m.author || '') + ':  [' + (m.ts || '') + ']\n' + (m.text || '');
    }).join('\n\n');
  }
  return JSON.stringify(payload);
}

// Turn parsed messages (with any fetched thread replies) into source sections. A question
// and the lead's replies stay together so the answer keeps its context. Short chatter is dropped.
function slackSections(messages, channel) {
  return (messages || []).map(function (m) {
    var text = cleanSlackText(m.text);
    if (m.replies && m.replies.length) {
      text += '\n\nReplies:\n' + m.replies.map(function (r) { return '- ' + (r.author || 'Reply') + ': ' + cleanSlackText(r.text); }).join('\n');
    }
    return { m: m, text: text.slice(0, 4000) };
  }).filter(function (x) { return x.text.length >= 25; }).map(function (x) {
    return {
      sectionId: 'SL-' + hashString(channel.id + '|' + x.m.ts),
      sourceType: 'CSQ_SLACK', title: '#' + channel.name,
      heading: '#' + channel.name + ' \u00B7 ' + x.m.postedAt + (x.m.replies && x.m.replies.length ? ' \u00B7 ' + x.m.replies.length + ' repl' + (x.m.replies.length > 1 ? 'ies' : 'y') : ''),
      path: 'CSQ Slack #' + channel.name, url: null, postedAt: x.m.postedAt, text: x.text
    };
  });
}
