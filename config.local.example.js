// Copy this file to config.local.js and fill in your team's values.
// config.local.js is gitignored so the token never lands in the public repo.
// Without it the extension runs in direct mode (personal Gemini keys in
// background.js).
self.FKM_CONFIG = {
  workerUrl: "", // e.g. "https://forkable-macros.yourname.workers.dev"
  teamToken: "", // the TEAM_TOKEN secret you set on the Worker
};
