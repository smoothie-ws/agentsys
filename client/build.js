'use strict';
// Build only reviewed public files; never copy a source directory recursively.
const fs = require('node:fs');
const path = require('node:path');
const files = require('./public-files.json');
const root = path.resolve(__dirname, '..');
function build(output) {
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error('Build destination must not exist: ' + destination);
  for (const name of files) {
    const source = path.join(root, name);
    if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) throw new Error('Asset must be a regular file without symlinks: ' + name);
  }
  fs.mkdirSync(destination, {recursive: true});
  for (const name of files) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, name), target);
  }
  return destination;
}
if (require.main === module) console.log(build(process.argv[2] || path.join(root, 'dist', 'client')));
module.exports = {build};
