# Release notes

For an SDK change that should ship, run `npm run changeset` and commit the new
`.changeset/*.md` file with the change. Before a release, run
`npm run version:prepare`; Changesets updates `packages/sdk/package.json` and
`packages/sdk/CHANGELOG.md`. Run `npm install --package-lock-only --ignore-scripts`
to sync the lockfile. Review and commit those changes on `main`, then
create a matching `vX.Y.Z` tag or dispatch `release.yml` from `main`.

The release workflow refuses pending Changesets changes and mismatched tags. It
uses npm trusted publishing, which must be configured for the GitHub repository
and the exact workflow filename `release.yml` in the package's npm settings.
The package's `repository.url` must match the eventual GitHub repository before
release. Neither this configuration nor a local test publishes the package.
