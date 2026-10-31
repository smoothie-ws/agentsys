/** Script globals. Data and context.state must contain JSON values. */
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
type FlowControl = 'break' | 'continue';
interface SignalOutput {
  emit(options?: {handles?: FlowControl[]; failFast?: boolean}): Promise<FlowControl | undefined>;
}
declare const node: {
  readonly input: Readonly<Record<string, Json | undefined>>;
  /** Data outputs and signal handles are addressed by their exact names. */
  readonly output: Record<string, any> & {readonly out: SignalOutput};
  display(...values: unknown[]): void;
  reread(name: string): Promise<Json | undefined>;
  sleep(ms: number): Promise<void>;
  widgets: {
    (list: Array<Record<string, Json>>): Promise<unknown>;
    set(values: Record<string, Json>): Promise<unknown>;
  };
  readonly cancelled: boolean;
  readonly flow: {break(): never; continue(): never; cancel(): never; abort(): never};
};
declare const context: {
  readonly project_id: string;
  readonly workflow_id: string;
  readonly node_id: string;
  readonly instance_id: string | null;
  readonly resource_id: string | null;
  readonly widgets: Readonly<Record<string, Json>>;
  readonly event: {
    payload?: Record<string, Json>;
    connected?: string[];
    widget?: {id: string; kind: string; label?: string; value: Json};
  };
  /** Shared durable workflow JSON. Assign/delete properties; the root is read only. */
  readonly state: {[key: string]: Json};
  readonly execution: Readonly<{
    run_id: string;
    dispatch_id: string;
    parent_dispatch_id: string | null;
    invocation_id: string;
    parent_invocation_id: string | null;
    graph_revision: string;
    policy: Readonly<
      Partial<
        Record<
          'max_duration_ms' | 'max_dispatches' | 'max_invocations' | 'max_parallelism' | 'max_active_operations',
          number
        >
      >
    >;
  }>;
};
declare function agentsys(method: string, path: string, body?: Json, query?: Record<string, Json>): Promise<any>;
