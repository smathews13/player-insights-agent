
import {
  esm_exports,
  init_esm
} from "./chunk-YWMHP6NH.mjs";
import {
  __commonJS,
  __toCommonJS
} from "./chunk-LLUDDZ3A.mjs";

// node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-unsupported.js
var require_getMachineId_unsupported = __commonJS({
  "node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-unsupported.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getMachineId = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    async function getMachineId() {
      api_1.diag.debug("could not read machine-id: unsupported platform");
      return void 0;
    }
    exports.getMachineId = getMachineId;
  }
});
export default require_getMachineId_unsupported();
