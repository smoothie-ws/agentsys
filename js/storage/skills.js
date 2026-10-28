// Agent Skills files: YAML frontmatter followed by the Markdown instruction.
'use strict';
const SkillFile = (() => {
  const yaml = typeof jsyaml !== 'undefined' ? jsyaml : require('../vendor/js-yaml.min.js');
  const validName = name => typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
  const slug = name => String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64).replace(/-+$/,'') || 'skill';
  function validate(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !validName(meta.name)) throw new Error('Skill name must be 1–64 lowercase letters, digits or single hyphens.');
    if (typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) throw new Error('Skill description must contain 1–1024 characters.');
    if (meta.compatibility !== undefined && (typeof meta.compatibility !== 'string' || !meta.compatibility.trim() || meta.compatibility.length > 500)) throw new Error('Invalid skill compatibility.');
    if (meta.license !== undefined && typeof meta.license !== 'string') throw new Error('Invalid skill license.');
    if (meta['allowed-tools'] !== undefined && typeof meta['allowed-tools'] !== 'string') throw new Error('Invalid allowed-tools.');
    if (meta.metadata !== undefined && (!meta.metadata || typeof meta.metadata !== 'object' || Array.isArray(meta.metadata) || Object.values(meta.metadata).some(v=>typeof v!=='string'))) throw new Error('Skill metadata must map keys to strings.');
  }
  function read(markdown) {
    if (typeof markdown !== 'string') throw new Error('Invalid SKILL.md document.');
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
    if (!match) throw new Error('SKILL.md needs YAML frontmatter with name and description.');
    const meta = yaml.load(match[1]);
    validate(meta);
    return {meta, instruction:match[2].replace(/^\r?\n/,'').trimEnd()};
  }
  function write(meta, instruction) {
    validate(meta);
    if (typeof instruction !== 'string') throw new Error('Invalid skill instruction.');
    return '---\n'+yaml.dump(meta,{lineWidth:100,noRefs:true,sortKeys:false})+'---\n\n'+instruction.replace(/\r\n/g,'\n').trimEnd()+'\n';
  }
  return {read,write,slug,validName};
})();
if (typeof module !== 'undefined') module.exports = SkillFile;
