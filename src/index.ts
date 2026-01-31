
export type TwigReadableStream = ReadableStream<Uint8Array>;

export type TwigRenderFn = (this: TwigTemplateContext) => Promise<void>;
type BlobLoaderContext = { options: Record<string, unknown>; runtime: TwigRuntime };
export type BlobLoader = (this: BlobLoaderContext, hash: string) => TwigReadableStream;
export type TwigFilter = (subject: unknown, ...args: any[]) => Promise<unknown>;
export type TwigFunction = (...args: any[]) => Promise<unknown>;
export type TwigFilterPipelineItem = [name: string, ...args: Array<unknown>];

export interface TwigTemplate {
  name: string;
  extends?: string;
  blocks?: Record<string, TwigRenderFn>;
  main?: TwigRenderFn;
}

export interface TwigRuntimeOptions {
  loadBlob?: BlobLoader;
  blobOptions?: Record<string, unknown>;
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

  write(chunk: string | Uint8Array | ArrayBufferLike): void {
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
  textEncoder = new TextEncoder();

  constructor(options: TwigRuntimeOptions = {}) {
    this.options = options;
  }

  loadBlob(hash: string): TwigReadableStream {
    const loader = this.options.loadBlob ?? fileBlobLoader;
    return loader.call({options: this.options.blobOptions ?? {}, runtime: this}, hash);
  }

  convertToUint8Array(data: string | Uint8Array | ArrayBufferLike): Uint8Array {
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
    async escape(value) {
      if (value == null) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  });

  return runtime;
}
