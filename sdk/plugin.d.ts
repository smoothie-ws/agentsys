/** Compile plugins to CommonJS JavaScript and include this file in the TypeScript project. */
declare module '@agentsys/plugin' {
  export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
  export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  export interface Disposable {
    dispose(): void | Promise<void>;
  }
  export interface Registration extends Disposable {
    readonly id: string;
    readonly kind: string;
  }
  export type SectionRef = string | Registration;
  export interface Field {
    key: string;
    label?: string;
    type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'json' | 'secret' | 'list';
    endpoint?: string;
    default?: Json;
    help?: string;
    required?: boolean;
    unique?: boolean;
    options?: string[];
    format?: 'id' | 'url';
    shape?: 'object' | 'array';
  }
  export interface LibraryAction {
    id: string;
    title: string;
    endpoint: string;
  }
  export interface Section {
    id: string;
    title: string;
    icon?: string;
    description?: string;
    parent?: SectionRef;
    after?: SectionRef;
    actions?: LibraryAction[];
    folderActions?: LibraryAction[];
    item?: {name?: string; format?: 'json'; fields?: Field[]; actions?: LibraryAction[]};
  }
  export interface LibraryItem {
    id: string;
    name: string;
    description: string;
    folder: string;
    values?: {[key: string]: Json};
    content?: string;
  }
  export interface SettingField {
    key: string;
    label: string;
    type: 'text' | 'textarea' | 'number' | 'boolean' | 'select';
    default?: Json;
    description?: string;
    options?: string[];
    min?: number;
    max?: number;
  }
  export interface View {
    id: string;
    title: string;
    entry: string;
    icon?: string;
    section?: 'plugins' | 'library';
    parent?: string;
    navigation?: {title: string; items: {page: string; title?: string; icon?: string}[]};
  }
  export interface StoredValue<T = Json> {
    key: string;
    value: T;
    version: number;
    updated: number;
  }
  export interface App {
    request<T = Json>(method: Method, path: string, body?: object | null, query?: object): Promise<T>;
    library: {
      registerSection(section: Section): Registration;
      registerCollection(section: Section & {item: NonNullable<Section['item']>}): Registration;
      registerNodeCatalog(file: string): Registration;
      listItems(section: SectionRef, query?: object): Promise<{folders: string[]; items: LibraryItem[]}>;
      createItem(section: SectionRef, item: Partial<LibraryItem>): Promise<LibraryItem>;
      updateItem(section: SectionRef, id: string, item: Partial<LibraryItem>): Promise<LibraryItem>;
      deleteItem(section: SectionRef, id: string): Promise<Json>;
      /** Available only to the owning plugin's isolated host, never through resource CRUD. */
      getSecret(section: SectionRef, id: string, key: string): Promise<string | null>;
    };
    commands: {
      register(id: string, handler: (...args: any[]) => unknown, options?: {title?: string}): Registration;
      execute<T = unknown>(id: string, ...args: unknown[]): T | Promise<T>;
    };
    endpoints: {
      register(
        name: string,
        handler: (request: {method: Method; body: {[key: string]: Json}; query: {[key: string]: string}}) => unknown,
        options?: {methods?: Method[]; permissions?: string[]; timeout?: number}
      ): Registration;
    };
    views: {
      register(view: View): Registration;
      registerTile(tile: {id: string; title: string; entry: string; height?: number}): Registration;
    };
    templates: {register(template: {id: string; name: string; file: string}): Registration};
    events: {
      on(
        event: 'workspace.changed' | 'library.changed' | 'settings.changed' | 'storage.changed',
        handler: (event: {keys: string[]}) => unknown
      ): Registration;
    };
    timers: {
      setTimeout(callback: () => unknown, ms: number): Disposable;
      setInterval(callback: () => unknown, ms: number): Disposable;
    };
    settings: {
      register(fields: SettingField[]): Disposable;
      get(): Promise<{[key: string]: Json}>;
      set(values: {[key: string]: Json}): Promise<{schema: {fields: SettingField[]}; values: {[key: string]: Json}}>;
    };
    storage: {
      get<T = Json>(key: string): Promise<StoredValue<T>>;
      set<T extends Json>(key: string, value: T, version?: number): Promise<StoredValue<T>>;
      delete(key: string, version?: number): Promise<{deleted: string}>;
      list<T = Json>(prefix?: string): Promise<StoredValue<T>[]>;
    };
    /** Returns a checked {{secret:NAME}} reference; never exposes the credential to plugin code. */
    secrets: {reference(name: string): Promise<string>};
    navigation: {open(pathOrCollection: string | Registration): Promise<null>};
    notifications: {show(title: string, body?: string): Promise<Json>};
    workflows: {
      get(project: string, workflow: string): Promise<Json>;
      edit(
        project: string,
        workflow: string,
        operations: {method?: Method; path: string; body?: object}[]
      ): Promise<Json>;
      run(project: string, workflow: string, options?: object): Promise<Json>;
      inspect(project: string, workflow: string): Promise<Json>;
    };
  }
  export interface ExtensionContext {
    readonly id: string;
    readonly app: App;
    readonly dependencies: {[id: string]: {id: string; version: string}};
    readonly subscriptions: {add(...disposables: Disposable[]): void};
    /** Runs once after registrations are committed; collection API calls are available here. */
    onReady(handler: () => unknown): Disposable;
  }
}
