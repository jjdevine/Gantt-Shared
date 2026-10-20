// Shared-repository defaults for this deployment.
// If this file is missing, or owner/repo are empty, the app runs in local-only
// mode and behaves exactly like the original single-user version.
// Values here can be overridden per browser from the Settings dialog.
window.GANTT_CONFIG = {
  apiBase: 'https://api.github.com',   // GitHub Enterprise Server: https://<host>/api/v3
  owner: 'jjdevine',
  repo: 'Gantt-Shared',
  branch: 'main',
  dataPath: 'data/people'
};
