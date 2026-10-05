# Service Architect for VS Code

Read-only graph navigation for typed `sa-python-dsl` projects. The Python project is
the only editable source. The viewer is the same EmbeddedDesigner used by Codex,
including read-only Auto Layout, search, highlighting, and both graph renderers.

Install `sa-python-dsl` in your Python environment and ensure `sa-dsl` is on PATH, or
set `serviceArchitect.saDslCommand` to its absolute executable path. Open a trusted
workspace containing `.service-architect/project.yaml` with `authoring.mode: python`,
then run **Service Architect: Open Python Graph** from the command palette. If the
workspace has multiple projects, choose one. A click on a graph node or link opens the
matching Python expression. Saving Python files refreshes the read-only graph.

Right-click `.service-architect/project.yaml` for **Materialize Effective Python DSL**
or **Generate and Merge Project**. The first command evaluates Python, round-trips via
canonical YAML, and writes a reviewable snapshot to `python-dsl/model/` without
touching authoring code. It refuses to overwrite user edits in that snapshot. The
second command calls the existing ServiceGen generator and merge script. Set the
default destinations in `serviceArchitect.materializedDslDirectory` and
`serviceArchitect.generatedProjectDirectory`, or enter another path when prompted.

The command **executes the project's Python authoring code** through the bounded
`sa-dsl` worker. Only open projects you trust. Opening the graph does not write YAML
or upload graph data; the two explicit commands above write only to chosen destinations.

## Develop

Run `make docker-build` to validate and package the extension in Docker. The
installable file is `dist/service-architect-vscode-0.1.0.vsix`. The build copies
the project into the image; it does not mount source directories. Set
`DEPENDENCY_DOCKER_REGISTRY` and `NPM_CONFIG_REGISTRY` for mirrored base images
and npm packages. For interactive development, run `npm run check` and press F5
in VS Code's Extension Development Host.

`media/designer.js` and `media/designer.css` are packaged build artifacts from
`service_architect_vue3/embedded`; use `sa-python-dsl/scripts/sync_ide_assets.py`
after building a new immutable UI version. Run it with `--check` before packaging to
verify that both IDE plugins contain that exact build. If the viewer is built in a
separate release checkout, pass `--source-dir /path/to/public/mcp-ui/0.1.10` to both
sync and check. Do not edit the bundles directly.
