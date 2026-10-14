module.exports = {
  test: (valueToPrint: unknown) => typeof valueToPrint === 'string',
  serialize: (stringToPrint: string) => {
    return `"${stringToPrint.replace(/([A-Fa-f0-9]{64})/, 'HASH-REPLACED')}"`
  }
}
