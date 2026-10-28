# Interface guide

The whole interface is one tree, shown twice. The **second panel** is the tree: every section of the sidebar fills it with rows, a row with children has a chevron that unfolds it, and the open row is highlighted. The **page** beside it shows the children of the open row as cards. The same rule holds in every section, so what you learn in one works in the others:

| Section | Second panel (tree) | Page of the open row |
| --- | --- | --- |
| **Projects** | projects → their workflows | Projects: a card per project; a project: a card per workflow (with a Run button); a workflow opens its editor |
| **Library** | Providers, Skills, Nodes → their items (Nodes: groups → nodes) | Library: a card per kind; a kind: a card per item (Custom Nodes also per group); an item opens its form (a Custom Node opens its graph editor) |
| **Settings** | Editing, Appearance, Keyboard shortcuts | the chosen section |
| **API** | folders → calls, with search | the chosen call |

There is no "All projects" row: the **Projects** row of the sidebar is the list of all projects. The sidebar holds only the main sections, with no lists inside. Rows have a "⋯" menu (the same menu opens from the "⋯" of a card), "+" in the panel header creates something in the open section (a project; in the Library an item of any kind, a group, an import), and every tree starts folded each time you open a section (nothing is remembered). Library items can be dragged: a Custom Node onto a group row moves it there. Cards of projects, workflows, Library items and groups share one look with the nodes and groups of the canvas (same surface, corner radius, shadow and title), and their previews are drawn in the colours of the canvas; a Custom Node is tinted like a Complex Node. Every page starts with a path (`Projects / Alpha`) and a title, and its main actions on the right.

The open row joins the next panel like a folder tab, with concave curves above and below the connection (three tones: sidebar, second panel, content). The highlight **glides** to the row you pick and reaches the panel edge; the button, curved joins and receiving panel share one continuous gradient, fading from the bright outer edge into the panel. The fade stays inside that shape and does not spread behind the other section buttons. The second panel, the content and the Properties panel have four rounded outer corners, including when folded. When the second panel is folded to icons, a row inside a closed group is shown by the group's own icon. Settings > Appearance > *Effects* controls connected navigation together with the other visual effects; there is no separate navigation switch. The gradient follows panel resizing and folding, and its content-side fade extends above and below the selected row without repainting the site background. Because the open section and item are shown on the left, there is no breadcrumb bar. Both panels have a draggable edge: drag it narrow (or double-click it) to fold the panel to icons, drag the folded one to open it. The **logo** folds or unfolds the sidebar. The second panel stays next to the workflow editor (the open workflow is highlighted in the project tree); the open editors are in the tab bar. **Ctrl+K** jumps to any project, workflow, Library kind, item or group, or page by name (Enter opens the first match, the arrow keys walk the list) and finds nodes and groups across all projects.

Everything is stored in this browser. See the README for running the site.

## The canvas

- **Types** are named records of fields. The types of a workflow are the Library's plus its own. The Library's types are the types the Custom Nodes of the Library define: a type becomes global when a Library node that uses it is saved, so nothing is imported or managed. There is no list of them in the Library. The type selector shows them under *Library* and the workflow's own under *This workflow* (**Types** in the Workflow section of the side panel, developer mode; *New type…* in a slot's type selector opens the editor). A Library type is changed in a Custom Node of the Library (the button of the type opens the node that defines it, and there the type has an Edit button): the change is for every node and workflow. A type that no node defines and no workflow uses is removed by itself. A Library node carries the definitions of its types, so it stands alone: placing or pasting it matches them by ID, then by name and shape in the Library, and only otherwise adds them to the workflow as its own. Only `any` is built in. A type without fields may have a control (text, long text, code, number, checkbox, or a choice among options: an enum; code is a long text with syntax highlighting): a free input of that type shows it on the node, its value is the default of the input, and the *Inputs* list of a Custom Node has the same field. An output of such a type can also show the control (**Show control** in the *Outputs* list of a Custom Node): the value typed on the node is what the output holds, so a Value node needs no code; the code may overwrite it. A type may instead be an **alias** of another type (for example `Script`, an alias of `Text` with the Code control): it has its own name, colour and control, and fits and is fitted by its target both ways; an alias has no fields. Slots of a type take its colour on sockets, wires and the minimap, and a wire has to join slots whose types fit (a slot of type any fits everything).
- **Widgets** are fields on a node with no socket (text, textarea, number, checkbox, select, range, button, label, html, markdown). They belong to a node: declared in its Properties (the **Widgets** list: one card per widget with its kind, ID, label and the fields of its kind; in the Library editor they are part of the definition, so every copy has them) or put on a node through the `widgets` API; a Library node on a workflow shows those of the nodes inside it; nothing on a workflow creates them by hand, and a Script reads them as `context.widgets`. Library cards of nodes and groups carry an **Enabled** checkbox: off means dimmed and absent from the Add menu.
- **Nodes** are what you add (right-click the canvas > *Add*, or the **Add node** button): the Library nodes, in their groups. A node with the operation `script` is the only one that runs JavaScript (its code is the `script` input); **Signal** sockets are white triangles and so are their wires, and an output signal may have any number of wires, as may an input signal. A node with the operation `on_run` is what **Run** fires; `on_placed`, `on_deleted`, `on_wired` and `on_widget` nodes fire for a copy of the Library node they are in. `await`, `node` (the inputs, outputs, signals, display and widgets of the Library node), `agentsys()` (the site's API, including `POST llm`) and `context` are available in the code; see the README.
- Any node on a canvas can be renamed (right-click > *Rename*, **F2**, or the **Name** field in Properties): a Custom Node's title and the name of a Complex Node or group belong to that copy only, so renaming it does not change the Library. A widget shows a caption only when it has a `label`.
- A **Reroute** is a point on a wire (right-click a wire > *Add reroute*).
- **Groups** frame related nodes. A group can define its own inputs and outputs (an input slot connects to a member's input socket, an output slot to a member's output socket), collapse into a single node, and be saved as a **custom node** that appears under *Add node*.

Every workflow or Custom Node editor you open gets a **tab** above the canvas, like files in a code editor: click to switch, the × or a middle click closes it. Tabs are remembered in this browser. Only graph editors are tabs; every other page is reached through the two panels and Ctrl+K, and remembers where it was left (Settings reopens on its section, Library on its kind or item). The browser's Back button returns to the previous page or graph.

Right-click empty space (or double-click it) for **Paste** and **Add** (the nodes of a level first, then its groups); Add places the node at that point. On an empty canvas the **Add node** button does the same. Drag empty space to pan, Shift-drag or Ctrl-drag to select, scroll to zoom and **Home** to fit everything. **Ctrl+G** groups, **Ctrl+Z / Ctrl+Shift+Z** undo and redo, **Delete** deletes (selected wires are disconnected), **X** deletes a node while reconnecting its wires, and **N** opens or closes the side panel. Every colour field (node color, type color, theme colors) opens the same picker as the node color button. Drop-down lists (every `<select>`) open as the same menu as the context menus, with the chosen entry marked and the groups of the list as headings; the field stays the browser's `<select>`, so its value and change event work as before. **M** (or the power button above the selection, or **Disable** in the context menu) disables the selected nodes, Complex Nodes and groups: a run skips what is disabled (a disabled group takes everything inside it along), and what it would feed gets nothing from it (an input with a default uses the default); it is dimmed with a power mark, and **Enable** (the same key) brings it back. **F** (the arrow in a header, or **Collapse** in the context menu) collapses nodes and groups: a collapsed group is a bar with its name, its members are hidden and move with it, and wires to them end on the bar. **G** switches snapping on and off: while it is on, nodes and groups moved or resized snap to the grid of the canvas dots (24 units at 100% zoom; the corner of what a group holds snaps when the group moves). Hold **Ctrl** when you start dragging a node and the nodes it feeds, the ones those feed, and so on (pinned ones stay) move with it; Ctrl-click without dragging still adds or removes a node from the selection. The strip along the bottom of the canvas lists the keys that work now, like Blender's status bar, and changes with the selection and while you drag; its **Snap** and **Keys** buttons switch snapping and the hints (**H**) on and off. Both choices are remembered in the browser. Every binding can be changed in Settings. In a code field **Tab** indents; **Escape** then **Tab** leaves the field.

## Running

Nothing runs while you edit, and nothing is edited while a run goes. **Run** fires every on_run node (the play button on a workflow card in the project page does the same without opening it) and the signals do the rest; during a run the button is **Stop**, and **Pause** (then **Resume**) keeps new nodes from starting. A node that runs shows a spinner in its header, a node that has run a check mark, a failed one a cross, one that was not started because its flow was cancelled (`node.flow`) a grey skip mark (only failures stay after the run); a Library node on the canvas shows the state of what runs inside it (a spinner while anything in it runs, else a cross if anything failed, else a check mark, else the skip mark), and the **Activity** tab in the side panel lists the outputs and errors of the last run. Editing the graph clears the results.

## The side panel

- The panel is docked to the canvas (connected navigation) and its icon rail has the same sliding highlight as the left panels. The minimap in the corner of the canvas folds away with its arrow button (the zoom buttons stay); the choice is remembered.
- **Workflow** holds the settings of the whole workflow: its name, its types and the graph problems.
- **Properties** shows the selected node, group, wire or selection. Nothing selected shows a short reminder.
- **Activity** shows the last run.

## The API

Everything the site does goes through an internal API that runs in the browser. The **API** page lists every method — its parameters, an example body and the answers it can give — and can download an OpenAPI description. Script nodes call it with `agentsys(method, path, body, query)`, for example:

```js
const projects = await agentsys('get', '/api/projects');
return projects.length;
```

## Groups, Complex Nodes and Custom Nodes

A **group** is a purely visual frame around nodes; groups can be nested.

A **Complex Node** has ports and behaves as one ordinary node on a canvas: it cannot be expanded, ungrouped or edited there. Complex Nodes are built in the Library:

1. Open **Library → Custom Nodes**, then **New node** (the button of the page, or **+ → New node** in the panel). A graph editor opens.
2. Build the node. The editor has one main group (the frame); nodes can be moved anywhere and the frame grows to keep them inside; you can also enlarge it by dragging its edges. You cannot delete, ungroup or nest it. Select the frame to name the node and bind its inputs and outputs in the side panel. You can still group nodes into subgroups inside it.
3. Name the node by renaming its main group. Changes are saved to the Library automatically.

In **Library → Custom Nodes** the nodes form a tree of groups, like the project list, and the page shows the groups and nodes of the open group as cards. Create a group with **New group** (or **+ → New group**) or, inside another group, with its ⋯ menu → **New group**; the same menu renames it, gives it an icon, or deletes it with everything inside (the dialog counts what will go). Put a node into a group by dragging its row onto the group row or with its ⋯ menu → **Move to**.

Saved Custom Nodes appear in the **Add** menu (right-click the canvas) in submenus that follow the same groups. To change one, open it in the Library (it opens as a graph editor; its description and icon are in the Properties of the main group), or right-click a placed copy → **Edit graph**; every placed copy is updated with its wires kept.

Right-click a tab for **Pin** (pinned tabs stay on the left and cannot be closed until unpinned), **Close**, **Close All** and **Close to the right**; pinned tabs are skipped by the bulk commands.

Right-click on any text field (or on selected text) always opens the text menu — **Cut**, **Copy**, **Paste**, **Select all** — instead of the menu of the node, card or canvas under it. The browser's own menu is never shown.

Groups: drag a node onto a group frame to put it in, and off the frame onto empty canvas to take it out (the frame is judged as it was when the drag started). Shortcuts follow the physical key, so they work on any keyboard layout. In the side panel every slot is one row: name, type, where its value comes from, and a single value control; only group ports also have a Default.

Dragging a node: drop it on a group frame to put it in; drop it on the zone that appears at the top of the canvas to take it out of its group; drop it on a wire to insert it into that wire (the wire enters its first fitting input and leaves its first fitting output). Frames keep their size during the drag. Ctrl+I inverts the selection inside the group of the selected nodes, or on the whole canvas. Selecting a node lights all its wires. A new connection to an occupied input replaces the old one.

The tabs of open editors are in the bar under the page, and Search (Ctrl+K) is at the upper right; the sidebar is folded with the logo. Press **B**, then drag on the canvas to select a rectangle of nodes and groups (a group is taken when its whole frame is inside). Menus close when you scroll or zoom; the Add submenu of the context menu has its own search. Custom Nodes and their groups can wear an icon (Library → "Change icon" in the ⋯ menu of a node or of a group, or the icon in the Properties of the node's main group). A new Custom Node starts with its main group at the smallest size; the frame grows around what is put inside. The colour picker has swatches, a saturation/brightness square, a hue slider and a hex field.

## Theme components and mobile layout

Appearance includes a full-width component editor. `style.components` stores optional overrides for panels, navigation, buttons, fields, menus, cards, nodes, canvas, ports and statuses. Missing values remain automatic. Component groups have no card background or outline; one Reset action clears the overrides. Colours accept RGB or RGBA hex; component roundness accepts 0–32 pixels. These overrides are included in saved themes and theme JSON files.

Skills have Name, Group, Description and Instruction fields. Native skill import/export uses SKILL.md; collections retain grouping in Library JSON. The server stores skills as Markdown files with YAML frontmatter, separately from catalog metadata.

The opened inspector section has rounded corners, while the icon rail and its wrapper have no fill or corner clipping. Node actions occupy a footer below the scrolling body. On phones, the bottom button and its receiving section share the same joining colour. Canvas text and code fields start at one line, can be stretched vertically, and retain a manual height when their value is saved.

At widths up to 760px, main destinations move to a bottom bar. Settings sections use a second horizontal bar; project, Library and API trees open in a bottom sheet. The graph inspector keeps its vertical rail on the right and opens over the canvas, with separate phone visibility preferences. Selected bottom tabs connect upward into their sections; their fades are vertical. The primary bar shows icons only. Touch users have Add and selection action buttons, larger targets and pinch zoom on empty canvas. Visual viewport changes keep search and dialogs above the keyboard; leaving the phone layout restores desktop panel state.

## Import and export

Projects has **Import project**; each project has **Export project** and **Import workflow**. Project and workflow card/tree menus include their export action, and the editor toolbar's three-dot menu includes **Export workflow**. Import creates a new project or workflow, preserves existing work and resolves name collisions. These files use the existing project/workflow exchange API and retain the complete graph.

Appearance supports named themes: **Save theme** stores the current palette, font and graph appearance under a chosen name, **Export theme** saves one preset, and **Import themes** reads one or a collection. The adjacent menu exports all saved themes or deletes the selected saved preset. Restoring default settings retains saved presets. Theme files use `{agentsys: 1, kind: "theme", name, style}` or `{agentsys: 1, kind: "themes", themes: [{name, style}]}`.

Built-in theme Dark uses background `#080808`, surface `#101010`, text `#ededed` and accent `#d9d9d9`.

Library items (providers, skills, Custom Nodes) can be saved as JSON with **Export** — **Export** on the page of a kind (or **Export all** in its ⋯ menu) saves the whole kind, the button in an item's form saves that one item — and added back with **Import…** (the page or **+**). The same menu has **Restore built-in items**, which adds back any of the items from `builtin/` that are missing. Files hold `{agentsys, kind, name, payload}`, or an array of them; a name already taken gets a number. Provider exports include the API key.

## Connections: several at once, and reroute points

Click a wire to select it; Shift/Ctrl-click adds or removes wires, and a selection rectangle (Shift-drag or **B**) that catches no node takes the wires it crosses. Delete, or **Disconnect**, removes them all.

**Add reroute** (right-click a wire, or the button in the side panel) breaks the wire in the middle with a small point. The point is a real node (`reroute`: one input, one output, passes the value on), so it can be moved, selected, deleted, or wired onward from its right side to any number of places; the two halves of the wire are separate connections that can be selected or broken again. **Dissolve** removes the point and joins the wires. A point takes the colour of the wire feeding it.

## Controller

The Controller sidebar page shows Initiatives (expand a task tree and decision log), approvals (answer with an optional comment), durable runs (waiting/interrupted statuses, Resume/Cancel/Replay and Trace), and version history with file comparison and restore. Timer waits show their due time; event waits show their event name. A waiting node remains marked on the canvas, with Resume/Cancel and a link to Controller. Approval waits must be answered in the approval queue.

The Library node inspector includes declared capabilities and explicit grants; workspace policies control what is allowed. AI-authored nodes use a code-and-capabilities review in Controller before elevation. Graph warnings are advisory and visible on the canvas and Controller's graph checks.
