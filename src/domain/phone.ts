export function normalizePhone(input: string): string {
  const jid = input.split("@")[0] ?? input;
  let digits = jid.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 12 || digits.length > 15) throw new Error("Número de telefone inválido");
  return digits;
}
