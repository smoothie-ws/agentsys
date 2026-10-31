if (node.input.status < 200 || node.input.status >= 300) throw Error('Model request failed: HTTP ' + node.input.status);
let data;
try {
  data = JSON.parse(node.input.response);
} catch {
  throw Error('The model did not return JSON');
}
const content = data.choices?.[0]?.message?.content ?? data.content;
if (typeof content === 'string') node.output.response = content;
else if (Array.isArray(content) && content.some(part => typeof part.text === 'string'))
  node.output.response = content
    .filter(part => typeof part.text === 'string')
    .map(part => part.text)
    .join('');
else throw Error('The model response contains no text');
