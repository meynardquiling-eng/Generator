// Parse the Slack connector's channel history text into candidate snippets. The
// connector returns readable text, not structured messages, so this is deliberately
// forgiving; nothing becomes a source until a trainer approves it.
//
// Expected line shape for a message header:  "Author Name:  [2026-08-03 01:59:17 CDT]"
// followed by the message body on the next lines.

var SLACK_HEADER_RE = /^(.*?):?\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [A-Z]{2,5})?)\]\s*(.*)$/;

function parseSlackChannelText(text, channelId) {
  var lines = String(text || '').split(/\r?\n/);
  var messages = [];
  var current = null;
  lines.forEach(function (line) {
    var m = SLACK_HEADER_RE.exec(line);
    if (m) {
      if (current) messages.push(current);
      current = { channelId: channelId, author: m[1].replace(/^[-*\s]+/, '').trim(), postedAt: m[2], ts: m[2], text: m[3] ? m[3].trim() : '' };
    } else if (current) {
      current.text = (current.text ? current.text + '\n' : '') + line;
    }
  });
  if (current) messages.push(current);
  return messages.map(function (msg) {
    msg.text = msg.text.trim();
    return msg;
  }).filter(function (msg) { return msg.text.length > 0; });
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

// Turn parsed messages into source sections. Short chatter ("thanks!", "+1") is dropped.
function slackSections(messages, channel) {
  return (messages || []).filter(function (m) { return m.text && m.text.length >= 25; }).map(function (m) {
    return {
      sectionId: 'SL-' + hashString(channel.id + '|' + m.ts + '|' + m.text),
      sourceType: 'CSQ_SLACK', title: '#' + channel.name,
      heading: '#' + channel.name + ' \u00B7 ' + m.postedAt,
      path: 'CSQ Slack #' + channel.name, url: null, postedAt: m.postedAt, text: m.text
    };
  });
}
