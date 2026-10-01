// Minimal JSON Schema check for model output (the subset our schemas use: object,
// array, string, boolean, number, enum, required, additionalProperties:false).
// Returns a list of problems; empty means the value fits.

function checkJsonAgainstSchema(value, schema, path) {
  path = path || '$';
  var problems = [];
  if (!schema) return problems;
  var t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [path + ' should be an object'];
    (schema.required || []).forEach(function (k) {
      if (!(k in value)) problems.push(path + '.' + k + ' is missing');
    });
    Object.keys(value).forEach(function (k) {
      var sub = (schema.properties || {})[k];
      if (!sub) {
        if (schema.additionalProperties === false) problems.push(path + '.' + k + ' is not expected');
        return;
      }
      problems = problems.concat(checkJsonAgainstSchema(value[k], sub, path + '.' + k));
    });
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [path + ' should be an array'];
    value.forEach(function (v, i) {
      problems = problems.concat(checkJsonAgainstSchema(v, schema.items, path + '[' + i + ']'));
    });
  } else if (t === 'string') {
    if (typeof value !== 'string') problems.push(path + ' should be a string');
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') problems.push(path + ' should be true/false');
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number') problems.push(path + ' should be a number');
  }
  if (schema.enum && schema.enum.indexOf(value) === -1) problems.push(path + ' must be one of: ' + schema.enum.join(', '));
  return problems;
}

// Turn a schema into a compact instruction for models that are not schema-constrained.
function describeSchemaForPrompt(schema) {
  return 'Reply with ONLY one JSON value (no prose, no code fence) that matches this JSON Schema exactly:\n' + JSON.stringify(schema);
}
