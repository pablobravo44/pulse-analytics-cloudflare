// jsdom ships no types and the worker tsconfig has no DOM lib; this covers only what tracker.test.ts touches.
declare module "jsdom" {
  interface FakeElement {
    src: string;
    setAttribute(name: string, value: string): void;
    dispatchEvent(event: unknown): boolean;
  }
  interface FakeDocument {
    head: { append(node: FakeElement): void };
    createElement(tag: string): FakeElement;
    getElementById(id: string): FakeElement | null;
  }
  interface FakeWindow {
    document: FakeDocument;
    navigator: object;
    MouseEvent: new (type: string, init?: object) => unknown;
    Event: new (type: string, init?: object) => unknown;
    eval(src: string): unknown;
  }
  export class JSDOM {
    constructor(html: string, options?: object);
    readonly window: FakeWindow;
  }
}
