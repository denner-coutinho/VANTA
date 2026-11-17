// Liga a verificação em duas etapas pela tela de Segurança, como uma pessoa da equipe faria.
// Os cargos da equipe só usam o painel com ela (Fase 8, parte 4).
import { totp } from "./totp.mjs";

export async function enableMfaUi(page, base, password, timeout = 30000) {
  const tid = (id) => `[data-testid="${id}"]`;
  await page.goto(`${base}/seguranca`);
  await page.click(tid("sec-start"), { timeout });
  await page.fill(tid("sec-password"), password);
  await page.click(tid("sec-continue"));
  await page.waitForSelector(tid("sec-secret"), { timeout });
  const secret = (await page.textContent(tid("sec-secret"))).replace(/\s/g, "");
  await page.fill(tid("sec-code"), totp(secret));
  await page.click(tid("sec-confirm"));
  await page.waitForSelector(tid("sec-codes"), { timeout });
  const codes = await page.$$eval(tid("sec-code-item"), (els) => els.map((e) => e.textContent.trim()));
  await page.click(tid("sec-codes-done"));
  return { secret, codes };
}
