/**
 * English dictionary — the source of truth for the key set.
 *
 * `ru` and `zh-CN` are typed as `Record<MessageKey, string>`, so a missing or
 * misspelled key fails the typecheck instead of silently falling back at
 * runtime. `npm run i18n:check` additionally verifies key parity and
 * placeholder parity in CI.
 */
export const en = {
  // ---- shared validation -------------------------------------------------
  'errors.text': '{name} must be a non-empty string without NUL characters.',
  'errors.integer': '{name} must be an integer between {min} and {max}.',
  'errors.aborted': 'The operation was cancelled.',
  'errors.crossOsPermission':
    '{reason} This operation crosses operating-system boundaries, so it needs full access or a one-time approval.',
  'errors.notApproved': 'Cross-system access was not approved.',
  'errors.forbiddenValue': 'The value of {name} is not allowed.',

  // ---- RPC bridge --------------------------------------------------------
  'rpc.frameTooLarge': 'The RPC frame exceeds the size limit.',
  'rpc.invalidFrame': 'Invalid RPC frame: {error}',
  'rpc.connectionClosed': 'The connection is closed.',
  'rpc.backpressure': 'The connection write queue is full.',
  'rpc.startTimeout': 'The bridge did not start in time. Check WSL and the Linux Node.js installation.',
  'rpc.protocolMismatch': 'The bridge protocol version does not match.',
  'rpc.cancelTimeout': 'The worker did not cancel the request in time, so the connection was closed.',
  'rpc.invalidResponse': 'The RPC response has no id.',
  'rpc.busy': 'This connection already has 32 pending requests.',
  'rpc.unknownMethod': 'Unknown bridge method.',
  'rpc.duplicateId': 'Duplicate RPC id.',
  'rpc.invalidRequest': 'Invalid RPC request.',
  'rpc.tooManyRequests': 'More than 16 requests are running at once.',
  'rpc.bridgeExited': 'The bridge exited. {stderr}',

  // ---- paths -------------------------------------------------------------
  'paths.linuxAbsolute': 'An absolute Linux path is required, for example /home/user/project.',
  'paths.windowsAbsolute':
    'An absolute drive path or a WSL UNC path is required; C:relative is not accepted.',
  'paths.invalidDistro': 'The distribution name is invalid.',
  'paths.distroMismatch': 'The path belongs to a different distribution than the selected one.',
  'paths.unrepresentable':
    'This Linux file name cannot be represented as a Windows UNC path. Use the WSL file tools instead.',

  // ---- encoding ----------------------------------------------------------
  'encoding.limitTooSmall': 'The limit cannot hold one complete character; use at least 4 bytes.',
  'encoding.invalid':
    'The text encoding or offset is invalid. Specify the real encoding, or read binary data as base64.',

  // ---- process -----------------------------------------------------------
  'process.argsArray': 'args must be an array of strings.',
  'process.commandTooLong':
    'The PowerShell command exceeds the Windows command-line limit. Run it from a script file instead.',

  // ---- worker ------------------------------------------------------------
  'worker.absolutePath': 'An absolute path for the current operating system is required.',
  'worker.invalidWindowsPath': 'Device paths and NTFS alternate data streams are not supported.',
  'worker.notFile': 'Only regular files can be read.',
  'worker.targetNotFile': 'The target must be a regular file.',
  'worker.danglingSymlink': 'The target is a dangling symbolic link.',
  'worker.expectedHash': 'expectedHash must be a SHA-256 digest or "absent".',
  'worker.fileConflict': 'The target file changed and was not overwritten. Read it again and retry.',
  'worker.targetBusy': 'The target file is already being written.',
  'worker.transferMissing': 'The transfer does not exist or is being committed.',
  'worker.transferWriting': 'The transfer does not exist or is being written.',
  'worker.transferLimit': 'More than 8 file transfers are open.',
  'worker.offsetMismatch': 'The file chunk offset is not continuous.',
  'worker.invalidChunk': 'A file chunk must be valid Base64 and at most 256 KiB.',
  'worker.sizeLimit': 'A single file copy is limited to 1 GiB.',
  'worker.writeFailed': 'The file write made no progress.',
  'worker.hashMismatch': 'The file check failed; the target was not replaced.',
  'worker.commandOrExecutable': 'Provide exactly one of command or executable.',
  'worker.invalidEnv': 'env must be an object with at most 64 valid variables.',
  'worker.wrongHost': 'This operation must run in the Windows worker.',
  'worker.invalidUrl': 'The URL must not contain credentials.',
  'worker.clipboardFailed': 'Clipboard operation failed: {error}',
  'worker.clipboardLimit': 'Clipboard text is limited to 256 KiB.',
  'worker.leaseBusy': 'Another launcher is already using this environment: {file}.',
  'worker.directoryName': 'The folder name is invalid.',
  'worker.directoryIsFile': 'This path points to a file; choose a folder.',
  'worker.pathConversionFailed': 'wslpath conversion failed: {error}',
  'worker.invalidEncoding': 'encoding must be utf8, gb18030 or base64.',
  'worker.writeLimit': 'A text write is limited to 512 KiB.',
  'worker.jobLimit': '32 background jobs are already tracked; remove finished ones and retry.',
  'worker.jobNotFound': 'The job does not exist; the connection may have been rebuilt.',
  'worker.jobRunning': 'Only finished jobs can be removed.',
  'worker.unknownWindowsAction': 'Unknown Windows action.',
  'worker.permissionDenied': 'The plugin policy refused this operation: {reason}',

  // ---- connector ---------------------------------------------------------
  'connector.notWsl': 'The current Linux host is not WSL; connect a distribution from Windows.',
  'connector.userMismatch':
    'A WSL host can only drive its own Linux user; connect from the Windows host to switch users.',
  'connector.wrongHost': 'Cross-distribution connections must start on the Windows host.',
  'connector.invalidTarget': 'target must be windows, wsl or local.',
  'connector.invalidUser': 'The Linux user name is invalid.',
  'connector.wrongRuntimeWsl': 'The WSL node actually points at Windows; configure a Linux node.',
  'connector.wrongRuntimeWindows': 'windowsNode must point at a Windows node.exe.',
  'connector.poolFull': '8 targets are already connected; disconnect an idle connection first.',
  'connector.pluginStopped': 'The plugin has stopped.',
  'connector.linuxNodeMissing':
    'Node.js is missing inside WSL. Install Node.js 22.19+ or 24+, or configure linuxNode.',

  // ---- service -----------------------------------------------------------
  'service.settingsUnreadable': 'The settings file cannot be read: {error}',
  'service.invalidUser': 'The Linux user name is invalid.',
  'service.distroNotFound': 'The selected distribution is not installed.',
  'service.noDistro': 'No WSL distribution is available. Install or select one first.',
  'service.invalidTarget': 'target must be wsl or windows.',
  'service.invalidDirection': 'direction must be linux or windows.',
  'service.invalidFileOperation': 'operation must be read, write, list or stat.',
  'service.unknownJobAction': 'Unknown job operation.',
  'service.jobEnvironmentMismatch':
    'This job belongs to another environment; use the target, distro and user it returned.',
  'service.fileTooLarge': 'The file copy limit is 1 GiB.',
  'service.sourceChanged': 'The source file changed during the copy, so it was cancelled.',
  'service.invalidCopyTargets': 'Both sides of a copy must be windows or wsl.',
  'service.preferenceBoolean': 'The preference value must be a boolean.',

  // ---- launcher ----------------------------------------------------------
  'launcher.nodeVersion': 'The Linux DSH needs Node.js 22.19+ from the 22.x line, or 24+.',
  'launcher.setupBusy': 'Environment preparation is already running.',
  'launcher.invalidInstallNetwork': 'installNetwork must be auto, windows or linux.',
  'launcher.npmCacheRequired': 'The Windows-assisted download needs a Windows host and a readable npm cache.',
  'launcher.setupFailed': 'Environment setup failed: {error}',
  'launcher.invalidNativeRoot': 'The Linux install directory must be an absolute path.',
  'launcher.alreadyRunning': 'This launcher is already running DSH for another distribution; stop it first.',
  'launcher.setupRequired': 'The Linux DSH is not installed yet. Run dsh-wsl setup --distro {distro}',
  'launcher.invalidPort': 'The port must be 0-65535; 0 selects a free port.',
  'launcher.patchMissing': 'The plugin startup configuration is missing; run dsh-wsl setup again.',
  'launcher.dshExited': 'DSH exited during startup.',
  'launcher.dshStartTimeout': 'DSH did not start within 180 seconds.',
  'launcher.localhostUnreachable':
    'The Linux DSH started, but the Windows localhost forward is unreachable. Run dsh-wsl doctor; the plugin never changes firewall or WSL network settings.',
  'launcher.invalidUrl': 'DSH returned a non-local address.',
  'launcher.installTaskFailed': 'The install task finished as {status}.',
  'launcher.progress.copying': 'Copying the plugin into the Linux file system.',
  'launcher.progress.downloading': 'Downloading Linux packages through Windows.',
  'launcher.progress.installing': 'Installing Linux DSH {version} in {runtime}.',
  'launcher.progress.ready': 'Linux DSH and the plugin are installed.',

  // ---- install cache -----------------------------------------------------
  'install.unsupportedArch': 'Linux installation supports x64 and arm64 only.',
  'install.npmFailed': 'The Windows npm download failed: {error}',
  'install.invalidSource': 'The dependency lock file contains a non-HTTPS package source.',

  // ---- inheritance -------------------------------------------------------
  'inherit.yamlInvalid':
    'The configuration contains YAML this plugin cannot inherit; the original file is unchanged.',
  'inherit.invalidOption': 'Inheritance options are switches for plugins, configuration or model accounts.',
  'inherit.pluginName': 'The plugin package name is invalid.',
  'inherit.pluginMismatch': 'The plugin package name does not match its installation directory.',
  'inherit.failed': 'The Linux configuration operation failed: {error}',
  'inherit.configTooLarge': 'The configuration file exceeds 256 KiB.',
  'inherit.invalidLayer': 'The Cordis configuration must be a list.',
  'inherit.missingPluginRecord': 'The install record for plugin {name} is missing.',
  'inherit.packFailed': 'Could not prepare plugin {name} for transfer.',
  'inherit.packName': 'The plugin package file name is invalid.',
  'inherit.windowsCache': 'Cannot read the Windows npm cache.',
  'inherit.progress.merge': 'Inheriting main-environment plugins and configuration; Linux overrides stay intact.',
  'inherit.progress.install': 'Installing inherited plugin dependencies inside Linux.',

  // ---- handoff -----------------------------------------------------------
  'handoff.invalidLocalUrl': 'DSH did not return a valid local address.',
  'handoff.invalidTarget': 'The local conversation target cannot be verified; re-enter Linux.',

  // ---- routes ------------------------------------------------------------
  'routes.contentType': 'application/json is required.',
  'routes.bodyTooLarge': 'The request body is too large.',
  'routes.invalidJson': 'The request JSON is invalid.',
  'routes.invalidJsonBody': 'A JSON object is required.',
  'routes.forbidden': 'Only same-origin local requests are accepted.',
  'routes.authRequired': 'Sign in through the DSH launch link first.',
  'routes.notFound': 'The endpoint was not found.',
  'routes.handoffInvalid': 'The switch link expired or is invalid; re-enter from the Windows panel.',
  'routes.requestObject': 'The request must be an object of at most 16 KiB.',
  'routes.rpcFormat': 'The RPC request format is invalid.',
  'routes.unsupportedHost': 'Enter the Linux environment from the Windows DSH.',
  'routes.invalidOrigin': 'The return address must belong to this local DSH.',
  'routes.startBusy': 'This environment is already starting; wait for it to finish.',
  'routes.setupBusy': 'The environment is being prepared; adjust inheritance options afterwards.',
  'routes.stopBeforePrepare': 'Stop that Linux DSH before preparing the environment.',
  'routes.refreshPanel': 'Refresh the panel and try again.',
  'routes.inheritanceBusy': 'The environment is being prepared; adjust inheritance options afterwards.',

  // ---- tools -------------------------------------------------------------
  'tools.status.description':
    'Show the Windows/WSL dual-host status, distributions and connected workers. Never starts a distribution.',
  'tools.exec.description':
    'Run a command in the selected system: wsl uses Linux bash, windows uses Windows PowerShell, or pass executable+args verbatim. Every command is independent; cwd and env are explicit and shell state is not shared. Connections are reused. Protected mode asks for approval each time.',
  'tools.files.description':
    'List, read, write or hash files directly in the system that owns them, without the Windows 9P file tools. Writes keep symbolic links and atomically replace the real target; the parent directory must exist. offset/limit are byte offsets. Use wsl_native_copy for binary files.',
  'tools.copy.description':
    'Copy one file between Windows and WSL in chunks (limit 1 GiB), verify the transfer SHA-256 and commit atomically. Existing files are refused by default. Interrupted transfers clean up their temporary file and are not replayed.',
  'tools.path.description':
    'Convert Windows and Linux paths with the selected distribution\'s own wslpath, detecting custom mount points and distribution mismatches.',
  'tools.windows.description':
    'Open a file, folder or http/https link on Windows, or read and write the text clipboard. Reading the clipboard also needs cross-system permission.',
  'tools.job.description':
    'Start, inspect, cancel or forget a cross-system background job. A job belongs to the connection that started it and ends when the plugin exits or disconnects. Job ids must be used with the original target and distro.',
  'tools.param.target': 'Operation target; defaults to wsl.',
  'tools.param.distro': 'WSL distribution; defaults to the one selected in the panel.',
  'tools.param.user': 'Linux user; defaults to the user saved for that environment. Reuse the user returned by a cross-environment task.',
  'tools.param.command': 'Shell script, alternative to executable.',
  'tools.param.executable': 'Program to run directly, alternative to command.',
  'tools.param.args': 'Program arguments passed verbatim.',
  'tools.param.cwd': 'Absolute working directory; Linux, Windows and WSL UNC paths are accepted.',
  'tools.param.env': 'Environment variables for this command only.',
  'tools.param.timeoutMs': 'Timeout in milliseconds; default 120000, foreground maximum 600000.',
  'tools.param.operation': 'File operation.',
  'tools.param.path': 'Absolute path of the file or directory.',
  'tools.param.content': 'Complete UTF-8 content for write.',
  'tools.param.expectedHash': 'Verify the previous SHA-256 before writing; use "absent" for a new file; omit to allow overwrite.',
  'tools.param.encoding': 'Text encoding or base64.',
  'tools.param.offset': 'Byte offset for read; paging offset for list.',
  'tools.param.limit': 'Maximum bytes or entries returned.',
  'tools.param.hidden': 'Include hidden entries when listing.',
  'tools.param.hash': 'Compute the SHA-256 when stat is used.',
  'tools.param.from': 'Source system.',
  'tools.param.to': 'Destination system.',
  'tools.param.source': 'Absolute source file path.',
  'tools.param.destination': 'Absolute destination file path; the parent directory must exist.',
  'tools.param.direction': 'Conversion direction.',
  'tools.param.action': 'Action to perform.',
  'tools.param.text': 'Clipboard text; may be empty.',
  'tools.param.jobId': 'Existing job id.',
  'tools.param.jobTimeout': 'Maximum runtime in milliseconds; at most 86400000 (24 hours).',
  'tools.error.execTimeoutLimit': 'Foreground timeout is at most 600000 ms; use wsl_native_job for long tasks.',
  'tools.error.jobTimeoutPositive': 'A background job needs a positive timeout.',

  // ---- permissions -------------------------------------------------------
  'permissions.mode.protected': 'Protected',
  'permissions.mode.protected.description':
    'Strict checks on Windows operations. Unknown or potentially dangerous actions require approval.',
  'permissions.mode.trusted': 'Trusted',
  'permissions.mode.trusted.description':
    'You allow specific operations in specific areas for a chosen period. Matching operations are not asked again.',
  'permissions.mode.fullAccess': 'Full Access',
  'permissions.mode.fullAccess.description':
    'Full access within the Windows user rights. Enabling it is an explicit action and can damage files by accident.',
  'permissions.reason.exec': 'Run a {target} command with the current user rights.',
  'permissions.reason.write': 'Write the {target} file {path}.',
  'permissions.reason.copy': 'Copy {source} to {destination}.',
  'permissions.reason.windows': 'Windows operation: {action}.',
  'permissions.reason.job': 'Manage a {target} background job: {action}.',
  'permissions.denied.stateFile':
    'The plugin configuration and state files cannot be changed through a tool; use the panel.',
  'permissions.denied.systemPath': 'Protected system locations cannot be changed through a tool: {path}.',
  'permissions.denied.outsideRoots':
    'This path is outside the allowed roots; approve it or add a grant in the panel: {path}.',
  'permissions.denied.symlink':
    'The resolved path leaves the allowed roots through a symbolic link: {path}.',
  'permissions.denied.unknownMode': 'Unknown permission mode: {mode}.',
  'permissions.denied.agentSwitch':
    'The permission mode can only be changed by the user in the panel, never by a tool call.',
  'permissions.denied.untrustedGrant': 'A permission grant must be created by an explicit user action.',
  'permissions.grant.expired': 'This permission grant has expired.',
  'permissions.fullAccess.confirm':
    'Enabling Full Access requires the explicit confirmation phrase typed by the user.',
  'permissions.fullAccess.warning':
    'Full Access lets agents change anything your Windows user can change, including files outside this project. There is no sandbox and no per-call approval.',
  'permissions.notice.protected':
    'Protected mode is active. Windows commands and file writes ask for approval.',
  'permissions.notice.trusted':
    'Trusted mode is active. Only operations inside your grants run without asking.',
  'permissions.notice.fullAccess':
    'Full Access is active. Every operation runs with your full Windows user rights.',

  // ---- tool descriptions of permission state -----------------------------
  'permissions.toolDescription.hint': 'Current plugin permission mode: {mode}.',

  // ---- CLI ---------------------------------------------------------------
  'cli.extraArguments': 'Unexpected arguments. Run dsh-wsl --help for usage.',
  'cli.unknownCommand': 'Unknown command {command}. Run dsh-wsl --help for usage.',
  'cli.started': 'The Linux DSH started: {url}\nPress Ctrl+C to stop this instance.',
  'cli.stopped': 'The Linux DSH exited: {status}. {stderr}',
  'cli.permissionMode': 'Permission mode: {mode}',
  'cli.noGrants': 'No standing grants.',
  'cli.grantLine': '{capability} on {target} in {root}, {expiry}',
  'cli.grantAdded': 'Grant created: {id}',
  'cli.grantRevoked': 'Grant revoked.',
  'cli.help': `DSH for WSL · dsh-wsl-native {version}

  dsh-wsl list                               list distributions
  dsh-wsl doctor [--distro Ubuntu]           check the Linux and Windows bridges
  dsh-wsl exec --command "uname -a"          run a Linux command
  dsh-wsl exec --target windows --command …  run Windows PowerShell
  dsh-wsl path --path "C:\\Work" --direction linux
  dsh-wsl setup --distro Ubuntu              install the standalone Linux DSH and plugin
  dsh-wsl start --distro Ubuntu --cwd /home/user/project
                                             start the Linux DSH; Ctrl+C stops it
  dsh-wsl permissions                        show the permission mode and grants
  dsh-wsl permissions --mode protected|trusted|full-access --confirm "FULL ACCESS"
                                             change the mode (user action only)

Options: --distro NAME  --user LINUX_USER  --cwd DIR  --port 0
         --linux-node LINUX_NODE_PATH  --windows-node NODE_EXE_PATH
         --install-network auto|windows|linux  --npm-cache ABSOLUTE_CACHE_PATH
         --timeout 120000  --no-open  --json  --locale en|ru|zh-CN

Windows DSH: dsh plugin --profile web add <absolute plugin path>
WSL DSH: the same package and the same install command.
`,

  // ---- permission panel --------------------------------------------------
  'ui.permissions.title': 'Windows permissions',
  'ui.permissions.mode': 'Mode',
  'ui.permissions.grants': 'Standing grants',
  'ui.permissions.noGrants': 'No standing grants. Trusted mode asks once per operation until you add one.',
  'ui.permissions.addGrant': 'Allow an area',
  'ui.permissions.grantCapability': 'Capability',
  'ui.permissions.grantTarget': 'Target system',
  'ui.permissions.grantRoot': 'Root path',
  'ui.permissions.grantHours': 'Valid for (hours)',
  'ui.permissions.grantCreate': 'Create grant',
  'ui.permissions.grantRevoke': 'Revoke',
  'ui.permissions.fullAccessWarning': 'Full Access has no sandbox and no per-call approval.',
  'ui.permissions.confirmFullAccess': 'Type FULL ACCESS to confirm',
  'ui.permissions.confirmPhrase': 'Confirmation phrase',
  'ui.permissions.switchMode': 'Apply mode',
  'ui.permissions.modeChanged': 'Permission mode is now {mode}.',
  'ui.permissions.grantCreated': 'Grant added for {capability} in {root}.',
  'ui.permissions.grantRemoved': 'Grant removed.',
  'ui.permissions.readOnlyNotice': 'Mode changes are user actions; agents cannot call this endpoint.',
  'ui.permissions.capability.exec': 'Run commands',
  'ui.permissions.capability.write': 'Write files',
  'ui.permissions.capability.copy': 'Copy files',
  'ui.permissions.capability.windows': 'Windows shell surface',
  'ui.permissions.capability.job': 'Background jobs',
  'ui.permissions.expires': 'Expires {time}',
  'ui.permissions.neverExpires': 'No expiry',
  'ui.permissions.error': 'The permission change failed: {error}',
} as const;

export type MessageKey = keyof typeof en;
