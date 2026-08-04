
import {
  TwigRuntime,
  TwigTemplate,
  getRuntime,
  BlobLoader,
  captureStream
} from '../src/index.js';

// Mock blob loader for testing
const mockBlobLoader: BlobLoader = function (hash: string) {
  const blobs: Record<string, string> = {
    'header': '<header>Site Header</header>',
    'footer': '<footer>Site Footer</footer>',
    'content': '<div>Main Content</div>',
  };

  return new ReadableStream({
    start(controller) {
      const content = blobs[hash] || `blob:${hash}`;
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    }
  });
};

describe('TwigRuntime', () => {
  describe('Basic rendering', () => {
    test('should render simple template', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'simple',
        async main() {
          this.write('Hello World');
        }
      };

      runtime.register([template]);
      const stream = runtime.render('simple');
      const result = await captureStream(stream);

      expect(result).toBe('Hello World');
    });

    test('should render template with variables', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'greeting',
        async main() {
          this.write(`Hello ${this.vars.name}`);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('greeting', { name: 'Alice' });
      const result = await captureStream(stream);

      expect(result).toBe('Hello Alice');
    });

    test('should throw error for non-existent template', () => {
      const runtime = new TwigRuntime();
      expect(() => runtime.render('nonexistent')).toThrow('Template not found: nonexistent');
    });
  });

  describe('Template inheritance', () => {
    test('should extend parent template', async () => {
      const runtime = new TwigRuntime();
      
      const base: TwigTemplate = {
        name: 'base',
        async main() {
          this.write('<html>');
          await this.block('content');
          this.write('</html>');
        },
        blocks: {
          async content() {
            this.write('Base content');
          }
        }
      };

      const child: TwigTemplate = {
        name: 'child',
        extends: 'base',
        blocks: {
          async content() {
            this.write('Child content');
          }
        }
      };

      runtime.register([base, child]);
      const stream = runtime.render('child');
      const result = await captureStream(stream);

      expect(result).toBe('<html>Child content</html>');
    });

    test('should call parent block', async () => {
      const runtime = new TwigRuntime();
      
      const base: TwigTemplate = {
        name: 'base',
        async main() {
          await this.block('content');
        },
        blocks: {
          async content() {
            this.write('Base: ');
          }
        }
      };

      const child: TwigTemplate = {
        name: 'child',
        extends: 'base',
        blocks: {
          async content() {
            await this.parent();
            this.write('Child');
          }
        }
      };

      runtime.register([base, child]);
      const stream = runtime.render('child');
      const result = await captureStream(stream);

      expect(result).toBe('Base: Child');
    });

    test('should support multi-level inheritance', async () => {
      const runtime = new TwigRuntime();
      
      const grandparent: TwigTemplate = {
        name: 'grandparent',
        async main() {
          this.write('[');
          await this.block('content');
          this.write(']');
        },
        blocks: {
          async content() {
            this.write('GP');
          }
        }
      };

      const parent: TwigTemplate = {
        name: 'parent',
        extends: 'grandparent',
        blocks: {
          async content() {
            await this.parent();
            this.write('-P');
          }
        }
      };

      const child: TwigTemplate = {
        name: 'child',
        extends: 'parent',
        blocks: {
          async content() {
            await this.parent();
            this.write('-C');
          }
        }
      };

      runtime.register([grandparent, parent, child]);
      const stream = runtime.render('child');
      const result = await captureStream(stream);

      expect(result).toBe('[GP-P-C]');
    });

    test('should throw error for missing parent template', () => {
      const runtime = new TwigRuntime();
      
      const child: TwigTemplate = {
        name: 'child',
        extends: 'nonexistent'
      };

      expect(() => runtime.register([child])).toThrow('Template not found: nonexistent');
    });
  });

  describe('Blocks', () => {
    test('should render nested blocks', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'nested',
        async main() {
          await this.block('outer');
        },
        blocks: {
          async outer() {
            this.write('<outer>');
            await this.block('inner');
            this.write('</outer>');
          },
          async inner() {
            this.write('<inner/>');
          }
        }
      };

      runtime.register([template]);
      const stream = runtime.render('nested');
      const result = await captureStream(stream);

      expect(result).toBe('<outer><inner/></outer>');
    });

    test('should detect circular block references', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'circular',
        async main() {
          await this.block('a');
        },
        blocks: {
          async a() {
            await this.block('a'); // Circular!
          }
        }
      };

      runtime.register([template]);
      const stream = runtime.render('circular');
      
      await expect(captureStream(stream)).rejects.toThrow('Circular block reference: a');
    });

    test('should get block content as string', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'getblock',
        async main() {
          const content = await this.getBlock('myblock');
          this.write(`[${content}]`);
        },
        blocks: {
          async myblock() {
            this.write('Block Content');
          }
        }
      };

      runtime.register([template]);
      const stream = runtime.render('getblock');
      const result = await captureStream(stream);

      expect(result).toBe('[Block Content]');
    });

    test('should return empty string for non-existent block', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'test',
        async main() {
          const content = await this.getBlock('nonexistent');
          this.write(`[${content}]`);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('test');
      const result = await captureStream(stream);

      expect(result).toBe('[]');
    });
  });

  describe('Blob loading', () => {
    test('should load blob content', async () => {
      const runtime = new TwigRuntime({ loadBlob: mockBlobLoader });
      
      const template: TwigTemplate = {
        name: 'withblob',
        async main() {
          await this.blob('header');
          await this.blob('content');
          await this.blob('footer');
        }
      };

      runtime.register([template]);
      const stream = runtime.render('withblob');
      const result = await captureStream(stream);

      expect(result).toBe('<header>Site Header</header><div>Main Content</div><footer>Site Footer</footer>');
    });

    test('should get blob as string', async () => {
      const runtime = new TwigRuntime({ loadBlob: mockBlobLoader });
      
      const template: TwigTemplate = {
        name: 'getblob',
        async main() {
          const header = await this.getBlob('header');
          this.write(`[${header}]`);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('getblob');
      const result = await captureStream(stream);

      expect(result).toBe('[<header>Site Header</header>]');
    });

    test('should use blob options', async () => {
      const customLoader: BlobLoader = function(hash: string) {
        const basePath = this.options.basePath as string;
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${basePath}/${hash}`));
            controller.close();
          }
        });
      };

      const runtime = new TwigRuntime({ 
        loadBlob: customLoader,
        blobOptions: { basePath: '/custom/path' }
      });
      
      const template: TwigTemplate = {
        name: 'test',
        async main() {
          await this.blob('test.txt');
        }
      };

      runtime.register([template]);
      const stream = runtime.render('test');
      const result = await captureStream(stream);

      expect(result).toBe('/custom/path/test.txt');
    });
  });

  describe('Filters', () => {
    test('should apply filter', async () => {
      const runtime = getRuntime();
      
      const template: TwigTemplate = {
        name: 'filtered',
        async main() {
          const result = await this.filter('<script>alert("xss")</script>', [['escape']]);
          this.write(result as string);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('filtered');
      const result = await captureStream(stream);

      expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    test('should apply filter pipeline', async () => {
      const runtime = getRuntime();
      
      runtime.registerFilters({
        async upper(value) {
          return String(value).toUpperCase();
        },
        async prefix(value, prefix: string) {
          return `${prefix}${value}`;
        }
      });

      const template: TwigTemplate = {
        name: 'pipeline',
        async main() {
          const result = await this.filter('hello', [
            ['upper'],
            ['prefix', '>>> ']
          ]);
          this.write(result as string);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('pipeline');
      const result = await captureStream(stream);

      expect(result).toBe('>>> HELLO');
    });

    test('should throw error for non-existent filter', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'test',
        async main() {
          await this.filter('test', [['nonexistent']]);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('test');

      await expect(captureStream(stream)).rejects.toThrow('Filter not found: nonexistent');
    });
  });

  describe('Functions', () => {
    test('should execute function', async () => {
      const runtime = new TwigRuntime();
      
      runtime.registerFunctions({
        async greet(name: string) {
          return `Hello, ${name}!`;
        }
      });

      const template: TwigTemplate = {
        name: 'test',
        async main() {
          const result = await this.execute('greet', 'World');
          this.write(result as string);
        }
      };

      runtime.register([template]);
      const stream = runtime.render('test');
      const result = await captureStream(stream);

      expect(result).toBe('Hello, World!');
    });

    test('should throw error for non-existent function', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'test',
        async main() {
          await this.execute('nonexistent');
        }
      };

      runtime.register([template]);
      const stream = runtime.render('test');

      await expect(captureStream(stream)).rejects.toThrow('Function not found: nonexistent');
    });
  });

  describe('Utility methods', () => {
    test('should convert string to Uint8Array', () => {
      const runtime = new TwigRuntime();
      const result = runtime.convertToUint8Array('Hello');
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
    });

    test('should pass through Uint8Array', () => {
      const runtime = new TwigRuntime();
      const input = new Uint8Array([1, 2, 3]);
      const result = runtime.convertToUint8Array(input);
      
      expect(result).toBe(input);
    });

    test('should convert ArrayBuffer to Uint8Array', () => {
      const runtime = new TwigRuntime();
      const buffer = new ArrayBuffer(3);
      const result = runtime.convertToUint8Array(buffer);
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(3);
    });

    test('should throw error for incompatible type', () => {
      const runtime = new TwigRuntime();
      expect(() => runtime.convertToUint8Array({} as any)).toThrow('Incompatible type');
    });
  });

  describe('Method chaining', () => {
    test('should support method chaining', () => {
      const runtime = new TwigRuntime();
      
      const result = runtime
        .registerFilters({ async test() { return 'test'; } })
        .registerFunctions({ async test() { return 'test'; } })
        .register([{ name: 'test' }]);

      expect(result).toBe(runtime);
    });
  });

  describe('Variable scoping', () => {
    test('should preserve variables in child blocks', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'scoping',
        async main() {
          await this.block('test');
        },
        blocks: {
          async test() {
            this.write(this.vars.name as string);
          }
        }
      };

      runtime.register([template]);
      const stream = runtime.render('scoping', { name: 'Alice' });
      const result = await captureStream(stream);

      expect(result).toBe('Alice');
    });

    test('should isolate variables between renders', async () => {
      const runtime = new TwigRuntime();
      
      const template: TwigTemplate = {
        name: 'test',
        async main() {
          this.write(this.vars.value as string);
        }
      };

      runtime.register([template]);
      
      const stream1 = runtime.render('test', { value: 'First' });
      const stream2 = runtime.render('test', { value: 'Second' });
      
      const result1 = await captureStream(stream1);
      const result2 = await captureStream(stream2);

      expect(result1).toBe('First');
      expect(result2).toBe('Second');
    });
  });
});

// ---------------------------------------------------------------------------
// Compiler-integration features: macros, include, escaper, markup, core
// ---------------------------------------------------------------------------

import {
  TwigEscaper,
  TwigMarkup,
  markup,
  createEscapeFilter,
  TwigTemplateContext,
} from '../src/index.js';
import { coreFilters, coreFunctions, registerCore } from '../src/core.js';

describe('TwigMarkup & escaper', () => {
  test('escape filter escapes html and passes TwigMarkup through', async () => {
    const runtime = getRuntime();
    const escape = runtime.filters.get('escape')!;

    expect(String(await escape('<b>&"\'</b>'))).toBe('&lt;b&gt;&amp;&quot;&#039;&lt;/b&gt;');
    expect(String(await escape(null))).toBe('');
    expect(await escape(markup('<i>safe</i>'))).toBeInstanceOf(TwigMarkup);
    expect(String(await escape(markup('<i>safe</i>')))).toBe('<i>safe</i>');
    // double-escape is a no-op: escape returns TwigMarkup
    expect(String(await escape(await escape('<x>')))).toBe('&lt;x&gt;');
  });

  test('built-in strategies: js, url, css, html_attr', async () => {
    const escaper = new TwigEscaper();
    expect(escaper.escape('a"b', 'js').content).toBe('a\\x22b');
    expect(escaper.escape('a b&c', 'url').content).toBe('a%20b%26c');
    expect(escaper.escape('a"b', 'css').content).toBe('a\\22 b');
    expect(escaper.escape('a<b>', 'html_attr').content).toBe('a&lt;b&gt;');
  });

  test('custom strategies register through the runtime reference', async () => {
    const runtime = getRuntime();
    runtime.escaper.register('shout', (value) => value.toUpperCase() + '!');
    const escape = runtime.filters.get('escape')!;
    expect(String(await escape('hey', 'shout'))).toBe('HEY!');
    expect(() => runtime.escaper.get('nope')).toThrow('Escape strategy not found: nope');
  });

  test('a composed escaper can be handed to the runtime', async () => {
    const escaper = new TwigEscaper().register('brackets', (value) => `[${value}]`);
    const runtime = getRuntime({ escaper });
    expect(String(await runtime.filters.get('escape')!('x', 'brackets'))).toBe('[x]');
  });

  test('write() accepts TwigMarkup', async () => {
    const runtime = new TwigRuntime();
    runtime.register([{
      name: 't',
      async main() { this.write(this.markup('<raw/>')); },
    }]);
    expect(await captureStream(runtime.render('t'))).toBe('<raw/>');
  });
});

describe('Macros field', () => {
  test('context.macros() reaches another registered template', async () => {
    const runtime = new TwigRuntime();
    runtime.register([
      {
        name: 'forms.twig',
        macros: {
          async input(c: TwigTemplateContext, name: unknown) {
            return `<input name="${name}"/>`;
          },
        },
        async main() { /* empty */ },
      },
      {
        name: 'page.twig',
        async main() {
          const f = this.macros('forms.twig');
          this.write(this.markup(await f.input(this, 'user')));
        },
      },
    ]);
    expect(await captureStream(runtime.render('page.twig'))).toBe('<input name="user"/>');
  });
});

describe('Native include', () => {
  const partials: TwigTemplate[] = [
    { name: 'card.twig', async main() { this.write(`[${this.vars.title}]`); } },
    {
      name: 'page.twig',
      async main() {
        this.write('A');
        await this.include('card.twig', { title: 'T' });
        await this.include('missing.twig', {}, { ignoreMissing: true });
        this.write(await this.getInclude('card.twig', { title: 'C' }));
        this.write('B');
      },
    },
  ];

  test('include streams; ignoreMissing skips; getInclude captures', async () => {
    const runtime = new TwigRuntime();
    runtime.register(partials);
    expect(await captureStream(runtime.render('page.twig'))).toBe('A[T][C]B');
  });

  test('include of an unregistered template throws without ignoreMissing', async () => {
    const runtime = new TwigRuntime();
    runtime.register([{
      name: 't',
      async main() { await this.include('nope.twig'); },
    }]);
    await expect(captureStream(runtime.render('t'))).rejects.toThrow('Template not found: nope.twig');
  });
});

describe('Core library (@tugrul/twig-runtime/core)', () => {
  test('registerCore wires filters and functions', async () => {
    const runtime = registerCore(getRuntime());
    expect(String(await runtime.filters.get('upper')!('abc'))).toBe('ABC');
    expect(await runtime.functions.get('range')!(1, 5, 2)).toEqual([1, 3, 5]);
    expect(await coreFunctions.has_some!([1, 5], async (v: unknown) => (v as number) > 4)).toBe(true);
    expect(await coreFilters.join!([1, 2, 3], ', ', ' and ')).toBe('1, 2 and 3');
  });
});
