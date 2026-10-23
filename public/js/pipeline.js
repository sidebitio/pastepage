// Ordered event pipeline: decrypts and applies batches of wire events strictly
// one after another, so a slow decrypt can never let a later event overtake it.

/**
 * Create a pipeline.
 * @param {object} opts
 * @param {(ev: object) => Promise<object|null|undefined>} opts.decrypt - payload,
 *   null on failure, undefined for kinds without ciphertext
 * @param {(ev: object, payload: any) => void} opts.apply - e.g. applyEvent on the state
 * @param {() => void} opts.reset - empties the state (used for snapshots)
 * @param {() => void} opts.onApplied - called once after each batch, to re-render
 * @returns {{push: (events: object[], opts?: {reset?: boolean}) => Promise<void>}}
 */
export function createPipeline({ decrypt, apply, reset, onApplied }) {
  let chain = Promise.resolve();

  async function runBatch(events, doReset) {
    try {
      if (doReset) reset();
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
     * @param {{reset?: boolean}} [opts] - reset: call reset() before this batch
     * @returns {Promise<void>} resolves when this batch is applied
     */
    push(events, { reset: doReset = false } = {}) {
      chain = chain.then(() => runBatch(events, doReset));
      return chain;
    },
  };
}
