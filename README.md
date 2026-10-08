# Service Architect for VS Code

## CLI installation and corporate networks

Requires VS Code 1.110 or later. If the CLI is missing, choose **Install and
continue**. The extension downloads pinned uv and Python into its private storage,
installs the bundled CLI, and resumes the original action. No shell installer,
project virtual environment changes, or manual proxy environment variables are needed.

The uv archive is downloaded through VS Code's HTTP client. Python and package
downloads use a short-lived authenticated loopback bridge which applies `http.proxy`,
`http.noProxy`, and the operating system's proxy/PAC settings on the extension host.
The native resolver is packaged for macOS, Windows and Linux, including both
Apple Silicon and Intel Macs; it is not downloaded during CLI setup. In a remote
workspace, installation uses the remote extension host's network configuration.

Existing `http.proxyAuthorization` is used for the configured manual proxy. If a
proxy requests Basic credentials that are not available, VS Code asks for them and
stores them in SecretStorage. The extension cannot read the editor's private
authentication cache or promise automatic NTLM/Kerberos sign-in. Corporate passwords
are not placed in child-process environments or command lines. TLS verification
remains enabled; corporate CA certificates must be trusted by the operating system.

Run `npm run check` for local proxy regressions and `npm run bundle` to prepare the
universal extension bundle. `node scripts/smoke-cli-setup.js` is an opt-in network
test for a clean container with system CA certificates and no existing CLI/uv;
it downloads dependencies, installs the CLI, checks reuse, and removes its temporary
environment. Tests cover per-destination routes, upstream 407, route fallback,
credential isolation, cancellation/closure, and native resolver loading. An actual
corporate PAC deployment still needs testing on that network.

## Create a project

Use **Service Architect: Import Project from YAML** to start from an existing
architecture. Select the YAML file and confirm the project name (defaults to the
workspace root folder name). This uses the same `<workspace-folder>-architecture`
layout and workspace-root generation destination as Create Project, then opens
the imported Python entrypoint and graph. The selected name becomes the imported
model display name; the input YAML remains unchanged. An existing destination is
rejected. Original Python factories, loops and comments are not recoverable from
YAML. The shared CLI command is `sa-dsl init --yaml model.yaml`; the source path
can be absolute or relative to `--project`. Update the external CLI to use this command.

Open the workspace folder, then run **Service Architect: Create Project** from
the command palette. The suggested project name is the root folder name. The
command creates `<workspace-folder>-architecture` containing `project.py`,
`.service-architect/project.yaml` and a `.gitignore` for local Python files, secrets
and temporary artifacts. The SA project root `.gitignore` excludes `.service-architect/build/`; no nested `.gitignore` is created.
It opens the Python file and graph viewer. The directory
name follows the root folder even if the display name is edited. An existing
architecture directory is never overwritten.

Use an updated `sa-python-dsl` installation that provides `sa-dsl init`. The
equivalent terminal command is `sa-dsl init`, with optional `--project PATH` and
`--name NAME`. Creation itself is local and does not contact AWS. The model starts
empty; add services and their languages in Python. Generation targets initially
include the supported implementations, without adding any services automatically.

Read-only graph navigation for typed `sa-python-dsl` projects. The Python project is
the only editable source. The viewer is the same EmbeddedDesigner used by Codex,
including read-only Auto Layout, search, highlighting, and both graph renderers.

Use the automatic installation, or install `sa-python-dsl` in your own Python
environment and set `serviceArchitect.saDslCommand` to its executable path. Open a trusted
workspace containing `.service-architect/project.yaml` with `authoring.mode: python`,
then run **Service Architect: Open Python Graph** from the command palette. If the
workspace has multiple projects, choose one. A click on a graph node or link opens the
matching Python expression. Saving Python files refreshes the read-only graph.
Each snapshot evaluates Python and saves the resulting YAML to `canonical.output`
from the manifest (`.service-architect/build/<workspace-folder>.yaml` for new projects), then
displays that same model. The SA project root `.gitignore` is created or extended
with `.service-architect/build/` when saving into that directory. Invalid models leave the previous
successful YAML unchanged. Source navigation does not rewrite the YAML.

Right-click a node (or use Shift+F10 / the Context Menu key on the selected node)
for **Python Code**, **Show Component** and **Show Pipeline**. The latter actions
appear only for actual membership and focus the same scopes as the viewer's
Components and Pipelines panels. They do not change the Python model.

Right-click `.service-architect/project.yaml` for **Materialize Effective Python DSL**
or **Generate and Merge Project**. The first command evaluates Python, round-trips via
canonical YAML, and writes a reviewable snapshot to `python-dsl/model/` without
touching authoring code. It refuses to overwrite user edits in that snapshot. The
second command calls the existing ServiceGen generator and merge script. Set the
default destinations in `serviceArchitect.materializedDslDirectory` and
`serviceArchitect.generatedProjectDirectory`, or enter another path when prompted.

Leave the generation destination empty to use `generation.outputDirectory` from
the selected SA project's manifest. New projects set it to `..`, placing generated
services in the workspace root beside `<workspace-folder>-architecture`. A missing
setting defaults to `.` for existing root-level projects. An explicit destination
overrides the manifest. Generating into the parent protects the entire architecture
directory, including its `.gitignore`.
The CLI exports the model locally, submits it to the remote AWS generation API,
waits for the job, downloads the ZIP, previews the merge, and applies it locally.
The progress notification displays these stages, including queued/running states
when using an API key. Generated files follow ServiceGen ownership rules;
user-owned files are preserved and stale files are not removed. Archive paths
conflicting with loaded authoring modules, credentials or project settings are rejected.

Use an updated `sa-python-dsl` CLI supporting `ide-generate --progress-json`.
Configure `SERVICE_ARCHITECT_API_KEY` in the IDE process environment or the selected
project's `.env` file. Never commit credentials; exclude `.env` in `.gitignore`.
`SERVICE_ARCHITECT_API_URL` can override the API endpoint. Process environment
values take precedence over `.env`. Generation uploads the architecture model,
not business implementation source files. A second action for the same project
is blocked while one is running; applying a merge is not cancellable mid-write.

The command **executes the project's Python authoring code** through the bounded
`sa-dsl` worker. Only open projects you trust. Opening or refreshing the graph
writes the local canonical YAML artifact but does not upload graph data. Code
generation uploads the model only when explicitly requested.

## Develop

Run `make docker-build` to validate and package the extension in Docker. The
installable file is `dist/service-architect-vscode-0.1.7.vsix`. The build copies
the project into the image; it does not mount source directories. Set
`DEPENDENCY_DOCKER_REGISTRY` and `NPM_CONFIG_REGISTRY` for mirrored base images
and npm packages. For interactive development, run `npm run check` and press F5
in VS Code's Extension Development Host.

`media/designer.js` and `media/designer.css` are packaged build artifacts from
`service_architect_vue3/embedded`; use `sa-python-dsl/scripts/sync_ide_assets.py`
after building a new immutable UI version. Run it with `--check` before packaging to
verify that both IDE plugins contain that exact build. If the viewer is built in a
separate release checkout, pass `--source-dir /path/to/public/mcp-ui/0.1.11` to both
sync and check. Do not edit the bundles directly.
