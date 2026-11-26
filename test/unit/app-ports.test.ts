import { describe, expect, it } from 'vitest';
import { createAppPorts } from '../../src/server/app-ports.ts';

describe("the app's ports, as the cockpit knows them", () => {
  it('are the ports the app gave, while nothing else tells of one', () => {
    expect(createAppPorts([8765, 8443]).current()).toEqual([8765, 8443]);
    expect(createAppPorts([]).current()).toEqual([]);
  });

  it("join every source's ports to those given, each once, read anew at each call", () => {
    const ports = createAppPorts([8765]);
    let listening: number[] = [];
    ports.addSource(() => listening);

    expect(ports.current()).toEqual([8765]);
    listening = [4310, 8765];
    expect(ports.current()).toEqual([8765, 4310]);
  });

  it('forget a source once it is removed', () => {
    const ports = createAppPorts([]);
    const remove = ports.addSource(() => [4310]);
    ports.addSource(() => [4311]);

    remove();

    expect(ports.current()).toEqual([4311]);
  });
});
