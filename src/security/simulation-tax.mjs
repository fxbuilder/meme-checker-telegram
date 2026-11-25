/**
 * Tax measurement by read-only simulation (Robinhood, HyperEVM, Elysium).
 *
 * WHAT WAS PROBED, and the result:
 *
 *   Robinhood   eth_simulateV1  WORKS      debug_traceCall  absent
 *   Elysium     eth_simulateV1  WORKS      debug_traceCall  present
 *   HyperEVM    eth_simulateV1  absent     debug_traceCall  absent
 *
 * HyperEVM also accepts a third-parameter state override on eth_call, but exposes no method
 * that reports post-execution state, so a balance DELTA cannot be read there.
 *
 * THE WORKING METHOD, found after the obvious one failed: simulate a transfer FROM A REAL
 * HOLDER.
 *
 * A simulated transfer needs the sender to actually hold the token. Overriding `balance` grants
 * native currency, not ERC-20 tokens, so a transfer from a synthetic sender reverts on the
 * token's own balance check (measured on TEXEL: status 0x0, gasUsed 0x5e9c). Reading "100% tax"
 * from that revert would be a fabrication.
 *
 * Passing a GENUINE holder as `from` sidesteps the problem entirely - no storage slot, no
 * balance override. Measured on TEXEL with the launch locker as sender:
 *
 *     statuses [0x1, 0x1]   sent 1e18   received 1e18   => transfer fee 0 bps
 *
 * That is an OBSERVED fee, not a declared one. When no holder is supplied, or its balance is
 * too small, the result is `unmeasurable` with the reason attached - never 0%.
 *
 * THEREFORE: a tax figure is reported only when it comes from a source that actually measured
 * it - a provider, or a simulation whose post-state we could genuinely read. Otherwise the
 * status is `unmeasurable` with the reason attached. `0%` is never substituted.
 */

const TIMEOUT_MS = 20_000;

export const SIMULATION_SUPPORT = {
  robinhood: { eth_simulateV1: true, debug_traceCall: false, stateOverrideViaCall: true },
  elysium: { eth_simulateV1: true, debug_traceCall: true, stateOverrideViaCall: true },
  hyperevm: { eth_simulateV1: false, debug_traceCall: false, stateOverrideViaCall: true },
};

export const TAX_STATUS = {
  MEASURED: 'measured',
  NOT_APPLICABLE: 'not-applicable',
  UNMEASURABLE: 'unmeasurable',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
};

/** JSON-RPC QUANTITIES must be minimal hex. Zero-padding them is rejected by Go clients. */
const quantity = (n) => '0x' + BigInt(n).toString(16);
/** Calldata arguments are 32-byte words - a different format from a quantity. */
const abiWord = (n) => BigInt(n).toString(16).padStart(64, '0');

async function rpc(url, method, params, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { why: 'transport', detail: `http ${res.status}` };
    const body = await res.json();
    if (body?.error) return { why: 'rpc', detail: String(body.error?.message ?? body.error).slice(0, 160) };
    return { value: body?.result };
  } catch (err) {
    return { why: 'transport', detail: String(err?.message ?? err) };
  }
}

/**
 * Decide whether a tax figure is obtainable AT ALL for this chain, before spending requests.
 *
 * This exists so the calling pipeline can render "not measurable here" immediately instead of
 * issuing a simulation that is guaranteed to fail.
 */
export function taxCapability(chainId) {
  const support = SIMULATION_SUPPORT[chainId];
  if (!support) return { measurable: false, status: TAX_STATUS.UNAVAILABLE, reason: `no simulation support probe for ${chainId}` };
  if (!support.eth_simulateV1 && !support.debug_traceCall) {
    return {
      measurable: false,
      status: TAX_STATUS.UNMEASURABLE,
      reason: `${chainId} exposes no method that reports post-execution state (no eth_simulateV1, no debug_traceCall)`,
    };
  }
  return {
    measurable: false,
    // Even where eth_simulateV1 exists, a TOKEN balance delta needs the token's storage slot.
    status: TAX_STATUS.UNMEASURABLE,
    reason: 'simulation exists but a token transfer needs the token balance storage slot, '
      + 'which is not part of any ABI; a balance override grants native currency only',
    simulationAvailable: true,
    support,
  };
}

/**
 * Attempt a real simulation to observe a transfer's balance delta.
 *
 * Returns a TYPED failure rather than a fabricated number whenever the observation was not
 * actually made. Callers must treat anything other than `measured` as "no figure".
 *
 * @param {object} opts
 * @param {string} opts.chainId
 * @param {string} opts.rpc
 * @param {string} opts.token
 * @param {string} [opts.sender]      address to act as (defaults to a fresh one)
 * @param {bigint} [opts.amount]      raw units to transfer
 * @param {object} [opts.balanceSlot] `{ slot }` if the token's balance slot is KNOWN
 */
export async function simulateTransferTax({
  chainId, rpc: rpcUrl, token, sender = null,
  recipient = '0x0000000000000000000000000000000000000003', amount = 10n ** 18n,
  balanceSlot = null, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS,
} = {}) {
  const capability = taxCapability(chainId);
  if (!capability.simulationAvailable) {
    return { status: capability.status, reason: capability.reason, taxBps: null };
  }

  // THE WORKING PATH: a real holder as `from` needs no storage slot and no balance override.
  if (sender) {
    const held = await rpc(rpcUrl, 'eth_call', [
      { to: token, data: '0x70a08231' + sender.slice(2).padStart(64, '0') },
    ], { fetchImpl, timeoutMs });
    if (held.why) return { status: TAX_STATUS.ERROR, taxBps: null, reason: held.detail };
    const senderBalance = held.value ? BigInt(held.value) : 0n;
    if (senderBalance < amount) {
      return {
        status: TAX_STATUS.UNMEASURABLE,
        taxBps: null,
        reason: `holder ${sender} holds ${senderBalance} raw units, less than the ${amount} needed to test`,
      };
    }

    const holderBody = [{
      blockStateCalls: [{
        // Only GAS MONEY is overridden. The tokens are genuinely in the holder's balance,
        // which is what lets the transfer pass the token's own balance check.
        stateOverrides: { [sender]: { balance: quantity(10n ** 24n) } },
        calls: [
          { from: sender, to: token, data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + abiWord(amount) },
          { from: sender, to: token, data: '0x70a08231' + recipient.slice(2).padStart(64, '0') },
        ],
      }],
      validation: false,
    }, 'latest'];

    const simHolder = await rpc(rpcUrl, 'eth_simulateV1', holderBody, { fetchImpl, timeoutMs });
    if (simHolder.why) return { status: TAX_STATUS.ERROR, taxBps: null, reason: simHolder.detail };

    const hcalls = simHolder.value?.[0]?.calls ?? [];
    if (hcalls[0]?.status !== '0x1') {
      return {
        status: TAX_STATUS.ERROR,
        taxBps: null,
        reason: `transfer from holder did not succeed (status ${hcalls[0]?.status ?? 'none'}): ${hcalls[0]?.error?.message ?? 'no reason'}`,
      };
    }
    const hret = hcalls[1]?.returnData;
    if (!hret || hret === '0x') {
      return { status: TAX_STATUS.ERROR, taxBps: null, reason: 'no post-state balance returned' };
    }
    const hReceived = BigInt(hret);
    if (amount === 0n) return { status: TAX_STATUS.ERROR, taxBps: null, reason: 'zero amount sent' };
    if (hReceived > amount) {
      return { status: TAX_STATUS.ERROR, taxBps: null, reason: 'recipient received more than was sent - not interpretable' };
    }
    return {
      status: TAX_STATUS.MEASURED,
      kind: 'transfer-fee',
      taxBps: hReceived === amount ? 0 : Number(((amount - hReceived) * 10_000n) / amount),
      sent: amount.toString(),
      received: hReceived.toString(),
      sender,
      method: 'simulateV1-from-holder',
      reason: null,
    };
  }

  // WITHOUT THE STORAGE SLOT THERE IS NO HONEST SIMULATION.
  //
  // Measured: overriding only `balance` grants gas money, not tokens, so the token's own
  // balance check reverts (gasUsed 0x5e9c on TEXEL). A revert is not a 100% tax.
  if (!balanceSlot) {
    return {
      status: TAX_STATUS.UNMEASURABLE,
      taxBps: null,
      reason: 'token balance storage slot unknown: a transfer from a balance-overridden sender '
        + 'reverts on the token\'s own check, and a revert is not a tax measurement',
      // Recorded so the state is visible rather than silently absent.
      wouldNeed: { balanceSlot: 'storage slot of the _balances mapping for the sender' },
    };
  }

  const senderSlotValue = null; // computed by the caller-supplied slot scheme
  void senderSlotValue;

  const body = [{
    blockStateCalls: [{
      stateOverrides: {
        [sender]: { balance: quantity(10n ** 24n) },
        [token]: { stateDiff: { [balanceSlot]: quantity(10n ** 24n) } },
      },
      calls: [
        { from: sender, to: token, data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + abiWord(amount) },
        { from: sender, to: token, data: '0x70a08231' + recipient.slice(2).padStart(64, '0') },
      ],
    }],
    validation: false,
  }, 'latest'];

  const sim = await rpc(rpcUrl, 'eth_simulateV1', body, { fetchImpl, timeoutMs });
  if (sim.why) return { status: TAX_STATUS.ERROR, taxBps: null, reason: sim.detail };

  const calls = sim.value?.[0]?.calls ?? [];
  const transferStatus = calls[0]?.status;
  if (transferStatus !== '0x1') {
    // A reverted transfer measured NOTHING. Reporting a tax from it would be a fabrication.
    return {
      status: TAX_STATUS.ERROR,
      taxBps: null,
      reason: `simulated transfer did not succeed (status ${transferStatus ?? 'none'}): ${calls[0]?.error?.message ?? 'no reason'}`,
    };
  }

  const ret = calls[1]?.returnData;
  if (!ret || ret === '0x') {
    return { status: TAX_STATUS.ERROR, taxBps: null, reason: 'no post-state balance returned' };
  }
  const received = BigInt(ret);
  if (amount === 0n) return { status: TAX_STATUS.ERROR, taxBps: null, reason: 'zero amount sent' };

  const taxBps = received >= amount ? 0 : Number(((amount - received) * 10_000n) / amount);
  return {
    status: TAX_STATUS.MEASURED,
    // A TRANSFER-fee measurement, not a buy/sell tax: a swap also crosses a pool, price
    // impact and DEX fees, which this deliberately does not attribute to the token.
    kind: 'transfer-fee',
    taxBps,
    sent: amount.toString(),
    received: received.toString(),
    reason: null,
  };
}

/**
 * Read a transfer fee the token DECLARES about itself, if it declares one.
 *
 * A declared getter is evidence of the token's intent; it is not a measurement of behaviour,
 * so the result is labelled `declared` and kept distinct from `measured`.
 */
export async function readDeclaredFees({ rpc: rpcUrl, token, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, selectorOf } = {}) {
  // Documented/likely getters only - a guessed selector reverts like an absent one, so a
  // table of names we have actually seen is the only honest way to probe.
  const GETTERS = ['transferFeeBps()', 'buyFeeBps()', 'sellFeeBps()', 'taxFeeBps()', 'feeBps()'];
  const found = {};
  for (const sig of GETTERS) {
    const sel = selectorOf(sig);
    const r = await rpc(rpcUrl, 'eth_call', [{ to: token, data: sel }, 'latest'], { fetchImpl, timeoutMs });
    if (r.value && r.value !== '0x') {
      try { found[sig] = Number(BigInt(r.value)); } catch { /* not a uint */ }
    }
  }
  return {
    status: Object.keys(found).length ? 'declared' : 'none-declared',
    // NEVER presented as a measured tax - these are self-reported values on an
    // attacker-controlled contract.
    source: 'declared-getter',
    values: found,
  };
}
