import { describe, expect, it } from 'vitest';
import { cameTrue, eventually } from '../support/eventually.ts';

describe('waiting for what no event announces', () => {
  it('gives what the check returns once it passes', async () => {
    let tries = 0;

    const found = await eventually(() => {
      tries += 1;
      if (tries < 3) throw new Error('not yet');
      return 'found';
    });

    expect(found).toBe('found');
    expect(tries).toBe(3);
  });

  it('waits for a check that answers later', async () => {
    expect(await eventually(async () => 'found')).toBe('found');
  });

  it('ends at once, with its error, when the reason to give up comes true', async () => {
    let tries = 0;
    const check = () => {
      tries += 1;
      throw new Error('not yet');
    };
    const giveUp = () => {
      if (tries === 2) throw new Error('it will never come');
    };

    await expect(eventually(check, giveUp)).rejects.toThrow('it will never come');
    expect(tries).toBe(2);
  });

  it('gives up before the first try when there is a reason already', async () => {
    let tried = false;
    const check = () => {
      tried = true;
    };

    await expect(
      eventually(check, () => {
        throw new Error('no use');
      }),
    ).rejects.toThrow('no use');
    expect(tried).toBe(false);
  });
});

describe('waiting for what may not come', () => {
  it('tells that it came, once it holds', async () => {
    let looks = 0;

    const came = await cameTrue(() => {
      looks += 1;
      return looks === 3;
    }, 1_000);

    expect(came).toBe(true);
    expect(looks).toBe(3);
  });

  it('tells that it did not come once the time ran out, having looked once more at the end', async () => {
    let looks = 0;

    const came = await cameTrue(
      () => {
        looks += 1;
        return false;
      },
      30,
      10,
    );

    expect(came).toBe(false);
    expect(looks).toBeGreaterThanOrEqual(2);
  });

  it('ends with the error of a look that throws', async () => {
    await expect(
      cameTrue(() => {
        throw new Error('the session is gone');
      }, 1_000),
    ).rejects.toThrow('the session is gone');
  });
});
