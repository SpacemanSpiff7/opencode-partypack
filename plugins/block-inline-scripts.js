function toolName(input, output) {
  return output?.tool ?? input?.tool ?? ""
}

function toolArgs(input, output) {
  return output?.args ?? input?.args ?? {}
}

const INLINE_SCRIPT_PATTERN = /(^|&&\s*|;\s*|\|\|\s*|\|\s*)(python3?|node)\s+((-[cep])(\s|$|[^A-Za-z0-9])|-(\s|$))/

export default async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (toolName(input, output) !== "bash") return

      const command = String(toolArgs(input, output).command ?? "")
      if (!INLINE_SCRIPT_PATTERN.test(command)) return

      throw new Error(
        "Inline scripts (python -c, python -, node -e, node -p) are blocked in this project. Write the script to scripts/util/<name>.py or scripts/util/<name>.mjs and run it by file path instead."
      )
    }
  }
}
