
export type TwigReadableStream = ReadableStream<Uint8Array>;

export type TwigRenderFn = (this: TwigTemplateContext) => Promise<void>;
type BlobLoaderContext = { options: Record<string, unknown>; runtime: TwigRuntime };
export type BlobLoader = (this: BlobLoaderContext, hash: string) => TwigReadableStream;
export type TwigFilter = (subject: unknown, ...args: any[]) => Promise<unknown>;
export type TwigFunction = (...args: any[]) => Promise<unknown>;
export type TwigFilterPipelineItem = [name: string, ...args: Array<unknown>];

export type TwigMacro = (context: TwigTemplateContext, ...args: unknown[]) => Promise<string>;

export interface TwigTemplate {
  name: string;
  extends?: string;
  blocks?: Record<string, TwigRenderFn>;
  macros?: Record<string, TwigMacro>;
  main?: TwigRenderFn;
}

export interface TwigRuntimeOptions {
  loadBlob?: BlobLoader;
  blobOptions?: Record<string, unknown>;
  escaper?: TwigEscaper;
}

export interface CaptureStreamOptions {
  textDecoder: {
    label?: string,
    options?: TextDecoderOptions
  }
}

export async function captureStream(stream: TwigReadableStream, params?: CaptureStreamOptions): Promise<string> {
    const {label, options} = params?.textDecoder ?? {};

    const textStream = (stream as ReadableStream<BufferSource>).pipeThrough(new TextDecoderStream(label, options));
    const chunks: string[] = [];
    const reader = textStream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return chunks.join('');
  }

export function fileBlobLoader(this: BlobLoaderContext, hash: string): TwigReadableStream {

  const { basePath = '.' } = this.options as { basePath?: string };

  return new ReadableStream({
    async start(controller) {
      try {
        const [fs, path] = await Promise.all([import('fs/promises'), import('path')]);
        const filePath = path.join(basePath, `${hash}.txt`);
        const file = await fs.open(filePath, 'r');
        const stream = file.readableWebStream();

        await stream.pipeTo(
          new WritableStream({
            write(chunk) {
              controller.enqueue(chunk);
            },
            close() {
              controller.close();
              file.close();
            },
            abort(err) {
              controller.error(err);
              file.close();
            }
          })
        );
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

/**
 * A string that is already safe for output. `write()` accepts it directly
 * and the `escape` filter passes it through untouched, which prevents
 * double-escaping of rendered fragments (captured blocks, macro output,
 * includes, parent() content).
 */
export class TwigMarkup {
  constructor(public readonly content: string) {}

  toString(): string {
    return this.content;
  }
}

export function markup(content: string | TwigMarkup): TwigMarkup {
  return content instanceof TwigMarkup ? content : new TwigMarkup(content);
}

export type EscapeStrategy = (value: string) => string;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

/**
 * Higher-order escape architecture: a registry of named strategies.
 *
 * Applications extend escaping in either of two ways:
 * - grab the internal reference and register directly:
 *     runtime.escaper.register('csv', (value) => ...);
 * - or compose their own escaper up front and hand it to the runtime:
 *     getRuntime({ escaper: myEscaper });
 *
 * The built-in `escape` filter is DERIVED from the escaper (see
 * createEscapeFilter), so registered strategies become immediately
 * usable in templates as `value|escape('csv')`.
 */
export class TwigEscaper {
  private strategies = new Map<string, EscapeStrategy>();

  constructor() {
    this.register('html', (value) =>
      value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]));

    this.register('js', (value) =>
      value.replace(/[^a-zA-Z0-9,._]/gu, (c) => {
        const code = c.codePointAt(0) as number;
        if (code > 0xffff) return '\\u{' + code.toString(16).toUpperCase() + '}';
        if (code > 0xff) return '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
        return '\\x' + code.toString(16).toUpperCase().padStart(2, '0');
      }));

    this.register('url', (value) => encodeURIComponent(value));

    this.register('css', (value) =>
      value.replace(/[^a-zA-Z0-9]/gu, (c) =>
        '\\' + (c.codePointAt(0) as number).toString(16).toUpperCase() + ' '));

    this.register('html_attr', (value) =>
      value.replace(/[^a-zA-Z0-9,.\-_]/gu, (c) => {
        const code = c.codePointAt(0) as number;
        const named: Record<number, string> =
          { 34: '&quot;', 38: '&amp;', 60: '&lt;', 62: '&gt;' };
        return named[code] ?? '&#x' + code.toString(16).toUpperCase().padStart(2, '0') + ';';
      }));
  }

  register(name: string, strategy: EscapeStrategy): this {
    this.strategies.set(name, strategy);
    return this;
  }

  get(name: string): EscapeStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`Escape strategy not found: ${name}`);
    }
    return strategy;
  }

  escape(value: unknown, strategy = 'html'): TwigMarkup {
    if (value instanceof TwigMarkup) {
      return value;
    }
    if (value == null) {
      return new TwigMarkup('');
    }
    return new TwigMarkup(this.get(strategy)(String(value)));
  }
}

/**
 * Build an `escape` filter bound to an escaper instance. Because the
 * filter closes over the strategy registry, strategies registered later
 * are picked up without re-registration.
 */
export function createEscapeFilter(escaper: TwigEscaper): TwigFilter {
  return async (value: unknown, strategy: string = 'html') =>
    escaper.escape(value, strategy);
}

export class TwigTemplateNode {
  template: TwigTemplate;
  parent: TwigTemplateNode | null = null;
  runtime: TwigRuntime;

  constructor(runtime: TwigRuntime, template: TwigTemplate) {
    this.runtime = runtime;
    this.template = template;
  }

  main(vars: Record<string, unknown> = {}): TwigReadableStream {
    let { template: { main }, parent } = this;

    while (!main && parent) {
      main = parent.template.main;
      parent = parent.parent;
    }

    if (main) {
      return this.createScope(main, vars);
    }

    throw new Error('Template or parents do not have main');
  }

  block(name: string, vars: Record<string, unknown>): TwigReadableStream | null {
    if (this.template.blocks?.[name]) {
      return this.createScope(this.template.blocks[name], vars, name);
    }

    if (this.parent) {
      return this.parent.block(name, vars);
    }

    return null;
  }

  private createScope(
    render: TwigRenderFn,
    vars: Record<string, unknown>,
    name: string | null = null
  ): TwigReadableStream {
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const context = new TwigTemplateContext(
            this,
            controller,
            { ...vars },
            name
          );
          await render.call(context);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });
  }
}

/**
 * Template execution context
 */
export class TwigTemplateContext {
  private node: TwigTemplateNode;
  private controller: ReadableStreamDefaultController<Uint8Array>;
  public vars: Record<string, unknown>;
  public name: string | null;

  constructor(
    node: TwigTemplateNode,
    controller: ReadableStreamDefaultController<Uint8Array>,
    vars: Record<string, unknown>,
    name: string | null
  ) {
    this.node = node;
    this.controller = controller;
    this.vars = vars;
    this.name = name;
  }

  async execute(name: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.node.runtime.getFunction(name);
    return await fn(...args);
  }

  async filter(subject: unknown, pipeline: Array<TwigFilterPipelineItem>): Promise<unknown> {
    let result = subject;

    for (const [name, ...args] of pipeline) {
      const filter = this.node.runtime.getFilter(name);
      result = await filter(result, ...args);
    }

    return result;
  }

  write(chunk: string | TwigMarkup | Uint8Array | ArrayBufferLike): void {
    this.controller.enqueue(this.node.runtime.convertToUint8Array(chunk));
  }

  private getBlockStream(name: string): TwigReadableStream | null {
    if (this.name === name) {
      throw new Error(`Circular block reference: ${name}`);
    }

    return this.node.block(name, this.vars);
  }

  private getParentStream(): TwigReadableStream | null {
    if (!this.name) {
      throw new Error('parent() can only be called inside a block');
    }

    return this.node.parent?.block(this.name, this.vars) ?? null;
  }

  async consumeStream(stream: TwigReadableStream): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.controller.enqueue(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async blob(hash: string): Promise<void> {
    const stream = this.node.runtime.loadBlob(hash);
    if (stream) {
      await this.consumeStream(stream);
    }
  }

  async block(name: string): Promise<void> {
    const stream = this.getBlockStream(name);
    if (stream) {
      await this.consumeStream(stream);
    }
  }

  async parent(): Promise<void> {
    const stream = this.getParentStream();
    if (stream) {
      await this.consumeStream(stream);
    }
  }

  /** Wrap already-rendered content so escape passes it through. */
  markup(content: string | TwigMarkup): TwigMarkup {
    return markup(content);
  }

  /** Macros of a registered template, for cross-template imports. */
  macros(name: string): Record<string, TwigMacro> {
    return this.node.runtime.getNode(name).template.macros ?? {};
  }

  /** Stream another registered template into the current output. */
  async include(
    name: string,
    vars: Record<string, unknown> = {},
    options: { ignoreMissing?: boolean } = {}
  ): Promise<void> {
    if (options.ignoreMissing && !this.node.runtime.hasNode(name)) {
      return;
    }
    await this.consumeStream(this.node.runtime.getNode(name).main(vars));
  }

  /** Render another registered template and capture it as a string. */
  async getInclude(
    name: string,
    vars: Record<string, unknown> = {},
    options: { ignoreMissing?: boolean } = {}
  ): Promise<string> {
    if (options.ignoreMissing && !this.node.runtime.hasNode(name)) {
      return '';
    }
    return captureStream(this.node.runtime.getNode(name).main(vars));
  }

  async getBlob(hash: string): Promise<string> {
    const stream = this.node.runtime.loadBlob(hash);
    return stream ? await captureStream(stream) : '';
  }

  async getBlock(name: string): Promise<string> {
    const stream = this.getBlockStream(name);
    return stream ? await captureStream(stream) : '';
  }

  async getParent(): Promise<string> {
    const stream = this.getParentStream();
    return stream ? await captureStream(stream) : '';
  }
}

export class TwigRuntime {
  private nodes = new Map<string, TwigTemplateNode>();
  filters = new Map<string, TwigFilter>();
  functions = new Map<string, TwigFunction>();
  options: TwigRuntimeOptions;
  escaper: TwigEscaper;
  textEncoder = new TextEncoder();

  constructor(options: TwigRuntimeOptions = {}) {
    this.options = options;
    this.escaper = options.escaper ?? new TwigEscaper();
  }

  loadBlob(hash: string): TwigReadableStream {
    const loader = this.options.loadBlob ?? fileBlobLoader;
    return loader.call({options: this.options.blobOptions ?? {}, runtime: this}, hash);
  }

  convertToUint8Array(data: string | TwigMarkup | Uint8Array | ArrayBufferLike): Uint8Array {
    if (data instanceof TwigMarkup) {
      return this.textEncoder.encode(data.content);
    }

    if (typeof data === 'string') {
      return this.textEncoder.encode(data);
    }

    if (data instanceof Uint8Array) {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }

    throw new TypeError('Incompatible type');
  }

  hasNode(name: string): boolean {
    return this.nodes.has(name);
  }

  getNode(name: string): TwigTemplateNode {
    const node = this.nodes.get(name);
    if (!node) {
      throw new Error(`Template not found: ${name}`);
    }
    return node;
  }

  getFilter(name: string): TwigFilter {
    const filter = this.filters.get(name);
    if (!filter) {
      throw new Error(`Filter not found: ${name}`);
    }
    return filter;
  }

  getFunction(name: string): TwigFunction {
    const fn = this.functions.get(name);
    if (!fn) {
      throw new Error(`Function not found: ${name}`);
    }
    return fn;
  }

  registerFilters(filters: { [name: string]: TwigFilter }): this {
    for (const [name, item] of Object.entries(filters)) {
      this.filters.set(name, item);
    }
    return this;
  }

  registerFunctions(functions: { [name: string]: TwigFunction }): this {
    for (const [name, item] of Object.entries(functions)) {
      this.functions.set(name, item);
    }
    return this;
  }

  register(templates: TwigTemplate[]): this {
    const children = new Map<string, TwigTemplateNode[]>();

    for (const template of templates) {
      const node = new TwigTemplateNode(this, template);
      this.nodes.set(template.name, node);

      if (template.extends) {
        const items = children.get(template.extends) ?? [];
        children.set(template.extends, items.concat(node));
      }
    }

    for (const [name, nodes] of children) {
      const parent = this.getNode(name);

      for (const node of nodes) {
        node.parent = parent;
      }
    }

    return this;
  }

  render(name: string, vars: Record<string, unknown> = {}): TwigReadableStream {
    return this.getNode(name).main(vars);
  }
}

export function getRuntime(options: TwigRuntimeOptions = {}): TwigRuntime {
  const runtime = new TwigRuntime(options);

  runtime.registerFilters({
    escape: createEscapeFilter(runtime.escaper),
  });

  return runtime;
}
