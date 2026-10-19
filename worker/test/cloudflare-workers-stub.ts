// Node stand-in for the workerd-only "cloudflare:workers" module, which the
// OAuth library imports for its WorkerEntrypoint base class. These tests only
// use the ExportedHandler shape, so an empty class is enough.

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
