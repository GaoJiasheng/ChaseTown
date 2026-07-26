const THREE_LOADER_ASSET_FAILURE = /\bTHREE\.[A-Za-z0-9_$]*Loader\b[\s\S]{0,320}\b(?:couldn['’]?t load|could not load|failed to (?:load|decode)|decode(?:r)? (?:failed|failure|error)|error (?:loading|decoding))\b/iu;

export function protocolDiagnosticText(message) {
  if (message?.method === "Runtime.consoleAPICalled") {
    return (message.params?.args ?? [])
      .map((argument) => (
        argument?.value
        ?? argument?.unserializableValue
        ?? argument?.description
        ?? ""
      ))
      .join(" ");
  }
  if (message?.method === "Log.entryAdded") {
    return message.params?.entry?.text ?? "";
  }
  return "";
}

export function isThreeLoaderAssetFailure(message) {
  if (
    message?.method !== "Runtime.consoleAPICalled"
    && message?.method !== "Log.entryAdded"
  ) return false;
  return THREE_LOADER_ASSET_FAILURE.test(protocolDiagnosticText(message));
}
