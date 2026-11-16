// ESM entry for the matheel package: re-exports the CommonJS build so both module systems share one copy.
import matheel from "./index.cjs";

export const { Matheel, MatheelError, decodeQr, verifyActivationCallback, verifyTelr } = matheel;
export default matheel;
