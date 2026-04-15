# GitHub Auto-Deploy Setup

For push-to-deploy + PR previews, the user installs the **Creek
Deploy** GitHub App and connects a repository to a Creek project:

1. Visit `https://github.com/apps/creek-deploy` and install on the
   account or organization that owns the repo.
2. GitHub redirects to `https://app.creek.dev/github/setup?installation_id=...`
   which claims the installation for the current team and lists the
   installation's repositories.
3. Either import a new project from the dashboard's New Project →
   Import Git Repository flow, or connect an existing project from
   its Settings → GitHub Connection section.
4. Pushes to the project's production branch trigger a full build +
   deploy; pull requests trigger a preview deployment and post a
   commit status with the preview URL.
5. `creek deploy --from-github [--project <slug>]` can trigger the
   same flow for the latest commit on demand (no push required). See
   `references/deployment-modes.md` for when to reach for this.
