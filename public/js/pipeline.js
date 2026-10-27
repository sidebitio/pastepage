// Ordered event pipeline: decrypts and applies batches of wire events strictly
// one after another, so a slow decrypt can never let a later event overtake it.

/**
 * Create a pipeline.
 * @param {object} opts
 * @param {(ev: object) => Promise<object|null|undefined>} opts.decrypt - payload,
 *   null on failure, undefined for kinds without ciphertext
 * @param {(ev: object, payload: any) => void} opts.apply - e.g. applyEvent on the state
 * @param {(rolled: number|undefined, cleared: number|undefined) => void} opts.reset - prepares the state for a
 *   snapshot; gets the snapshot's rolled value (the highest seq that rolled off the session) and cleared value (the
 *   seq of the session's last clear), e.g. keepRolled on the state
 * @param {() => void} opts.onApplied - called once after each batch, to re-render
 * @returns {{push: (events: object[], opts?: {reset?: boolean, rolled?: number, cleared?: number}) => Promise<void>}}
 */
export function createPipeline({ decrypt, apply, reset, onApplied }) {
  let chain = Promise.resolve();

  async function runBatch(events, doReset, rolled, cleared) {
    try {
      if (doReset) reset(rolled, cleared);
      for (const ev of events) {
        let payload;
        try { payload = await decrypt(ev); } catch { payload = null; }
        try { apply(ev, payload); } catch (err) { console.error(err); }
      }
      onApplied();
    } catch (err) {
      console.error(err);
    }
  }

  return {
    /**
     * Queue a batch behind all earlier ones.
     * @param {object[]} events - wire events in order
     * @param {{reset?: boolean, rolled?: number, cleared?: number}} [opts] - reset: call reset(rolled, cleared) before
     *   this batch
     * @returns {Promise<void>} resolves when this batch is applied
     */
    push(events, { reset: doReset = false, rolled, cleared } = {}) {
      chain = chain.then(() => runBatch(events, doReset, rolled, cleared));
      return chain;
    },
  };
}
