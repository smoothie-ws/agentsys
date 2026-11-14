// Server resource deployment for client plugins: the part of a plugin that lives on a server.
//
// Installing a client plugin changes this browser only. Deploying its declared resources (collections, Library
// nodes, workflow templates) changes one server, through the ordinary API and the plugin's capabilities. The two
// steps are separate on purpose: the same plugin can be installed on two clients, and the same client can point at
// two servers with different data. Deployment records are kept per environment.
//
// Nothing here loads server-side plugin code. A deployed Library node is an ordinary Script node: the server runs
// it without this client, this plugin, or any plugin host.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PluginDeploy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const STATE_VERSION = 1;

  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  /** Stable JSON: object keys sorted, so a checksum means the same thing across tabs and environments. */
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
          .join(',') +
        '}'
      );
    return JSON.stringify(value === undefined ? null : value);
  }
  function checksum(value) {
    const text = canonical(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'fnv1a-' + hash.toString(16).padStart(8, '0');
  }
  const freshState = (pluginId, environment = 'local') => ({
    version: STATE_VERSION,
    plugin: pluginId,
    environment,
    deployedAt: 0,
    collections: {},
    library: {},
    workflows: {},
  });
  function readState(value, pluginId, environment = 'local') {
    const base = freshState(pluginId, environment);
    if (!isObject(value)) return base;
    const copy = object => (isObject(object) ? JSON.parse(JSON.stringify(object)) : {});
    return {
      ...base,
      ...value,
      plugin: pluginId,
      environment: environment || value.environment || 'local',
      collections: copy(value.collections),
      library: copy(value.library),
      workflows: copy(value.workflows),
    };
  }
  const error = (code, message, extra = {}) => ({code, message, ...extra});
  const versionParts = value =>
    String(value || '0.0.0')
      .split('-')[0]
      .split('.')
      .map(Number);
  const compareVersions = (a, b) => {
    const left = versionParts(a),
      right = versionParts(b);
    for (let i = 0; i < 3; i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) < (right[i] || 0) ? -1 : 1;
    return 0;
  };

  /**
   * Deploys (or re-deploys) one plugin's declared resources. Idempotent: the same version makes no duplicates, and
   * redeploying after a switch recreates only what the current server lacks. User edits to data are preserved.
   *
   * @param record   a normalized plugin record (PluginManifest)
   * @param request  (method, path, body, query) => Promise<json> on the active environment
   * @param state    the deployment record for this plugin and environment (PluginDeploy.freshState)
   * @param environment  the environment id the record belongs to
   * @param force    update a collection definition even when its strategy is "create"
   * @param log      (message) => void
   */
  async function deploy(record, {request, state, environment = 'local', force = false, log = () => {}} = {}) {
    if (!record || !record.id) throw new TypeError('A plugin record is required');
    if (typeof request !== 'function') throw new TypeError('A request function is required');
    const next = readState(state, record.id, environment);
    const errors = [];
    const warnings = [];
    const summary = {collections: 0, library: 0, workflows: 0, nodes: 0, created: 0, updated: 0, skipped: 0};
    const contributes = record.contributes || {collections: [], library: [], workflows: []};
    const attempt = async (kind, name, work) => {
      try {
        const answer = await work();
        if (answer?.warning) warnings.push(error('warning', answer.warning, {kind, name}));
        return answer;
      } catch (failure) {
        errors.push(error(failure.code || 'deploy_failed', `${kind} "${name}": ${failure.message}`, {kind, name}));
        return null;
      }
    };

    // ----- collections: definitions are updated in place; records are never deleted or rewritten -----
    for (const definition of contributes.collections || []) {
      await attempt('collection', definition.name, async () => {
        const existing = (await request('GET', 'collections')).find(item => item.name === definition.name);
        const wanted = {
          title: String(definition.title || definition.name).slice(0, 120),
          description: String(definition.description || '').slice(0, 2000),
          schema: definition.schema || {type: 'object'},
        };
        const mark = checksum(wanted);
        const previous = next.collections[definition.name];
        if (existing) {
          const same = checksum({title: existing.title, description: existing.description || '', schema: existing.schema}) === mark;
          if (same) {
            next.collections[definition.name] = {...previous, checksum: mark, mode: definition.strategy || 'create'};
            summary.skipped++;
            return;
          }
          if ((definition.strategy || 'create') !== 'update' && !force) {
            warnings.push(
              error(
                'collection_exists',
                `The collection "${definition.name}" already exists with another definition; its records were kept. Set "strategy": "update" in the package to change it.`,
                {kind: 'collection', name: definition.name}
              )
            );
            next.collections[definition.name] = {...previous, checksum: mark, mode: 'create'};
            summary.skipped++;
            return;
          }
          await request('PUT', 'collections/' + encodeURIComponent(definition.name), wanted);
          summary.updated++;
        } else {
          await request('PUT', 'collections/' + encodeURIComponent(definition.name), wanted);
          summary.created++;
        }
        next.collections[definition.name] = {
          checksum: mark,
          mode: definition.strategy || 'create',
          deployedAt: Date.now(),
        };
        summary.collections++;
      });
    }

    // ----- Library nodes: ordinary Script-backed Custom Nodes, tagged with their owner -----
    const resourceNames = new Map();
    for (const node of contributes.library || []) {
      await attempt('library node', node.name, async () => {
        const wanted = {
          name: node.name,
          code: String(node.code || ''),
          inputs: Array.isArray(node.inputs) ? node.inputs : [],
          outputs: Array.isArray(node.outputs) ? node.outputs : [],
          grants: Array.isArray(node.grants) ? node.grants : ['graph.read'],
          description: String(node.description || '').slice(0, 2000),
          folder: String(node.folder || '').slice(0, 200),
          icon: node.icon,
          plugin: {id: record.id, name: node.name, version: record.version, checksum: ''},
        };
        const mark = checksum({...wanted, plugin: undefined});
        wanted.plugin.checksum = mark;
        const resources = await request('GET', 'resources');
        const owned = resources.filter(
          item => item.payload?.plugin?.id === record.id && item.payload?.plugin?.name === node.name
        );
        let existing = (next.library[node.name]?.id && resources.find(item => item.id === next.library[node.name].id)) || owned[0];
        if (!existing && node.adopt === true) existing = resources.find(item => item.name === node.name);
        if (existing && existing.payload?.plugin && existing.payload.plugin.id !== record.id)
          throw Object.assign(new Error(`“${existing.name}” belongs to the plugin "${existing.payload.plugin.id}"`), {
            code: 'resource_conflict',
          });
        // Another client may have deployed a newer version of this package. An older client must not silently
        // downgrade the node it finds; the newer definition stays and the older deployment reports why.
        if (existing?.payload?.plugin?.version && compareVersions(existing.payload.plugin.version, record.version) > 0) {
          warnings.push(
            error(
              'deployment_newer',
              `“${existing.name}” was deployed by a newer version (${existing.payload.plugin.version}); this package is ${record.version} and did not overwrite it.`,
              {kind: 'library node', name: node.name}
            )
          );
          next.library[node.name] = {
            ...next.library[node.name],
            id: existing.id,
            checksum: existing.payload.plugin.checksum || '',
            version: existing.payload.plugin.version,
          };
          resourceNames.set(node.name, existing.id);
          summary.skipped++;
          return;
        }
        let saved;
        if (!existing) {
          saved = await request('POST', 'library/script-nodes', wanted);
          summary.created++;
        } else {
          const previous = existing.payload?.plugin?.checksum;
          if (previous === mark && existing.payload?.plugin?.version === record.version) {
            next.library[node.name] = {...next.library[node.name], id: existing.id, checksum: mark, version: record.version};
            resourceNames.set(node.name, existing.id);
            summary.skipped++;
            return;
          }
          saved = await request('POST', 'library/script-nodes', {...wanted, resource_id: existing.id});
          summary.updated++;
        }
        if (!saved?.id) throw new Error('The server did not return the Library node');
        next.library[node.name] = {
          id: saved.id,
          checksum: mark,
          version: record.version,
          folder: wanted.folder,
          deployedAt: Date.now(),
        };
        resourceNames.set(node.name, saved.id);
        summary.library++;
        summary.nodes++;
      });
    }
    // Contributions placed earlier in this deployment are usable by a workflow even if their step failed.
    for (const [name, entry] of Object.entries(next.library)) if (entry?.id) resourceNames.set(name, entry.id);

    // ----- workflow templates: a project, a workflow, its Library nodes, and a run trigger -----
    for (const template of contributes.workflows || []) {
      await attempt('workflow template', template.name, async () => {
        const key = template.name;
        const projectTitle = String(template.project || `${record.title} templates`).slice(0, 100);
        const tag = `Deployed by the AgentSys plugin ${record.id} · ${key}`;
        const projects = await request('GET', 'projects');
        let previous = next.workflows[key] || {};
        let project = (previous.project_id && projects.find(item => item.id === previous.project_id)) || null;
        if (!project) {
          project = projects.find(item => item.description === tag) || null;
          if (!project) {
            const exact = projects.find(item => item.name === projectTitle);
            if (exact) {
              project = exact;
              warnings.push(
                error('project_adopted', `The workflow template uses the existing project “${projectTitle}”.`, {
                  kind: 'workflow',
                  name: key,
                })
              );
            }
          }
        }
        if (!project) {
          const made = await request('POST', 'projects', {name: projectTitle});
          await request('PUT', `projects/${made.id}`, {name: projectTitle, description: tag});
          project = {id: made.id, name: projectTitle, description: tag};
          summary.created++;
        } else if (!String(project.description || '').includes(tag)) {
          const info = await request('GET', `projects/${project.id}`);
          await request('PUT', `projects/${project.id}`, {
            name: info.project.name,
            description: info.project.description || tag,
          });
        }
        let workflow = (previous.workflow_id && (await request('GET', `projects/${project.id}`)).workflows.find(w => w.id === previous.workflow_id)) || null;
        if (!workflow) {
          const info = await request('GET', `projects/${project.id}`);
          workflow = info.workflows.find(item => item.name === template.name) || null;
          if (!workflow) {
            const made = await request('POST', `projects/${project.id}/workflows`, {name: template.name});
            workflow = {id: made.id, name: template.name};
            summary.created++;
          }
        }
        const graph = await request('GET', `projects/${project.id}/workflow`, undefined, {workflow_id: workflow.id});
        const placed = {};
        const siblings = (template.nodes || []).filter(node => node.library !== undefined);
        let offset = 0;
        for (const node of siblings) {
          const resourceId = resourceNames.get(node.library);
          if (!resourceId) {
            errors.push(
              error('missing_library', `Workflow "${key}" names the Library node "${node.library}", which this package does not contribute.`, {
                kind: 'workflow',
                name: key,
              })
            );
            continue;
          }
          let existing = (graph.complex || []).find(complex => complex.source?.resource_id === resourceId);
          if (!existing) {
            const made = await request('POST', `projects/${project.id}/custom-nodes/${resourceId}`, {
              point: node.point || {x: 0, y: offset * 260},
            }, {workflow_id: workflow.id});
            offset++;
            const group = made?.roots?.[0];
            existing = group ? {id: group} : null;
            // A placement returns the new group id; `${complex:}` is the node id the canvas and wires use.
            if (existing) (graph.complex || (graph.complex = [])).push({id: existing.id, source: {resource_id: resourceId}});
          }
          if (existing) placed[node.library] = 'complex:' + existing.id;
        }
        // A trigger makes the template runnable as saved. The Event is a native primitive, not plugin code.
        if (template.run !== false) {
          const snapshot = await request('GET', `projects/${project.id}/workflow`, undefined, {workflow_id: workflow.id});
          let event =
            (previous.event_id && snapshot.nodes.find(node => node.id === previous.event_id)) ||
            snapshot.nodes.find(node => node.node_type === 'custom' && node.config?.op === 'on_run') ||
            null;
          if (!event) {
            const made = await request('POST', `projects/${project.id}/primitives`, {
              primitive: 'event',
              point: {x: -360, y: 0},
            }, {workflow_id: workflow.id});
            event = {id: made.id};
            summary.created++;
          }
          const connections = [...snapshot.edges];
          for (const nodeId of Object.values(placed)) {
            const wired = connections.some(edge => edge.source === event.id && edge.target === nodeId);
            if (wired) continue;
            await request('POST', `projects/${project.id}/port-connections`, {
              add: [{source: event.id, source_port: 'out', target: nodeId, target_port: 'in'}],
            }, {workflow_id: workflow.id});
          }
          previous = {...previous, event_id: event.id};
        }
        next.workflows[key] = {
          ...previous,
          project_id: project.id,
          workflow_id: workflow.id,
          nodes: placed,
          checksum: checksum({nodes: template.nodes || [], run: template.run !== false}),
          deployedAt: Date.now(),
        };
        summary.workflows++;
      });
    }

    next.version = STATE_VERSION;
    next.deployedAt = Date.now();
    next.pluginVersion = record.version;
    if (errors.length) log(`${record.id}: ${errors.length} deployment problem(s)`);
    return {ok: errors.length === 0, errors, warnings, state: next, summary};
  }

  /** What the record says was deployed here, for the plugin page. It contacts no server. */
  function status(record, state) {
    const clean = readState(state, record?.id, state?.environment);
    const counts = {
      collections: Object.keys(clean.collections).length,
      library: Object.keys(clean.library).length,
      workflows: Object.keys(clean.workflows).length,
    };
    return {
      deployed: !!(counts.collections || counts.library || counts.workflows),
      deployedAt: clean.deployedAt || 0,
      pluginVersion: clean.pluginVersion || '',
      environment: clean.environment,
      counts,
    };
  }

  /** Drops the local record of a deployment. Server resources stay: deleting user data is never implicit. */
  function forget(pluginId, environment = 'local') {
    return freshState(pluginId, environment);
  }

  return {STATE_VERSION, canonical, checksum, freshState, readState, deploy, status, forget};
});
