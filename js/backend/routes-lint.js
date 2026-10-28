'use strict';
route(
  'GET',
  'projects/{project_id}/lint',
  'Read advisory graph warnings and graph/code statistics',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    return lintGraph(editor.snapshot());
  },
  {query: ['workflow_id']}
);
