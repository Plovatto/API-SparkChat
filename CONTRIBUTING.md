# Contributing

Thanks for helping improve the SparkChat API. By taking part, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Reporting problems

Open an [issue](https://github.com/Plovatto/API-SparkChat/issues/new/choose) with the problem, the steps to reproduce it, and the expected behavior. Interface problems belong in the [web client repository](https://github.com/Plovatto/SparkChat/issues). Report security issues through the [security policy](SECURITY.md).

## Sending changes

1. Create a branch from `main` with a prefix for the type of change: `feature/`, `fix/`, `chore/`, or `docs/`.
2. Write commits in the [gitmoji](https://gitmoji.dev/) format with [Conventional Commits](https://www.conventionalcommits.org/), for example `:bug: fix: count only connected calls toward the per-pair limit`.
3. Add tests for new features and bug fixes. Route tests use Supertest against `createApp`, and every test gets its own in-memory database from `test/support`.
4. Describe new routes and socket events with Zod schemas, so they show up in the docs at `/docs`.
5. If the change touches the database, generate a migration with `npm run db:generate` and commit it with the schema change.
6. Before opening the pull request, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
7. Open the pull request against `main` describing what was done, the details, and how it was tested. Its title follows the same format as the commits, and a check validates it.

Notable changes are recorded in the [changelog](CHANGELOG.md).
