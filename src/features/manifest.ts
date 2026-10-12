// Contributions of the built-in "Luma" feature module (commands, menus, settings). The code lives in src/features/*.ts
// and runs in the main thread through the extension API (see src/features/index.ts).
export const lumaManifest = {
  name: 'luma',
  publisher: 'luma',
  version: '1.0.0',
  displayName: 'Luma IDE features',
  engines: { vscode: '*' },
  contributes: {
    commands: [
      { command: 'luma.python.run', title: 'Run Python File', category: 'Python', icon: '$(play)' },
      { command: 'luma.python.stop', title: 'Stop Python', category: 'Python', icon: '$(debug-stop)' },
      { command: 'luma.python.restart', title: 'Restart Interpreter', category: 'Python' },
      { command: 'luma.python.repl', title: 'Open REPL', category: 'Python' },
      { command: 'luma.github.signIn', title: 'Sign In', category: 'GitHub' },
      { command: 'luma.github.signOut', title: 'Sign Out', category: 'GitHub' },
      { command: 'luma.github.openRepository', title: 'Open Repository', category: 'GitHub' },
      { command: 'luma.github.closeRepository', title: 'Close Repository (use the local workspace)', category: 'GitHub' },
      { command: 'luma.github.syncNow', title: 'Sync Now', category: 'GitHub' },
      { command: 'luma.github.createBranch', title: 'Create Branch', category: 'GitHub' },
      { command: 'luma.extensions.upload', title: 'Add Theme or Extension from File', category: 'Extensions' },
      { command: 'luma.extensions.manageUploaded', title: 'Remove Uploaded Themes and Extensions', category: 'Extensions' },
      { command: 'luma.ai.open', title: 'Open Assistant', category: 'AI' },
      { command: 'luma.ai.setApiKey', title: 'Set API Key', category: 'AI' },
      { command: 'luma.ai.newChat', title: 'New Chat', category: 'AI' },
      { command: 'luma.ai.explain', title: 'Explain This Code', category: 'AI' },
      { command: 'luma.ai.fix', title: 'Fix This Code', category: 'AI' },
      { command: 'luma.gradle.runTask', title: 'Run Task (in the remote runner)', category: 'Gradle' },
      { command: 'luma.gradle.showProjects', title: 'Show Build Files', category: 'Gradle' },
      { command: 'luma.runner.open', title: 'Open Terminal', category: 'Remote Runner' },
      { command: 'luma.runner.configure', title: 'Set Server URL', category: 'Remote Runner' }
    ],
    viewsContainers: { secondarySidebar: [{ id: 'luma-ai', title: 'Assistant', icon: '$(sparkle)' }] },
    views: { 'luma-ai': [{ type: 'webview', id: 'luma.ai.chat', name: 'Assistant' }] },
    configuration: {
      title: 'Luma',
      properties: {
        'luma.github.syncDelaySeconds': { type: 'number', default: 10, minimum: 3, maximum: 600, description: 'Seconds after your last edit before changes are committed and pushed to GitHub.' },
        'luma.ai.provider': { type: 'string', enum: ['github-models', 'anthropic', 'openai'], default: 'github-models', description: 'github-models: GitHub Models, using your GitHub sign-in or a token. anthropic: the Anthropic API. openai: any OpenAI-compatible chat completions endpoint (set luma.ai.baseUrl).' },
        'luma.ai.model': { type: 'string', default: '', description: 'Model ID. Empty uses a default: openai/gpt-4.1 for GitHub Models, claude-sonnet-5-5 for Anthropic. Required for other OpenAI-compatible endpoints.' },
        'luma.ai.baseUrl': { type: 'string', default: '', description: 'API base URL for the openai provider, for example https://api.openai.com/v1. The endpoint must allow browser requests (CORS).' },
        'luma.ai.inlineCompletions': { type: 'boolean', default: false, description: 'Suggest code as you type. Sends the code around your cursor to your provider after each pause, so it is off by default.' },
        'luma.ai.completionModel': { type: 'string', default: '', description: 'Model for inline suggestions. Empty uses luma.ai.model. A small, fast model is a good choice.' },
        'luma.runner.url': { type: 'string', default: '', markdownDescription: 'WebSocket URL of your remote runner, for example `wss://runner.example.com/ws`. See the Remote runner page on the project site.' }
      }
    },
    menus: {
      'editor/title': [
        { command: 'luma.python.run', when: 'resourceLangId == python && !luma.python.running', group: 'navigation@1' },
        { command: 'luma.python.stop', when: 'resourceLangId == python && luma.python.running', group: 'navigation@2' }
      ],
      'editor/context': [
        { command: 'luma.ai.explain', when: 'editorHasSelection', group: '9_ai@1' },
        { command: 'luma.ai.fix', when: 'editorHasSelection', group: '9_ai@2' }
      ],
      commandPalette: [
        { command: 'luma.python.stop', when: 'luma.python.running' }
      ]
    }
  }
}
