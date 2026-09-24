import { test, expect } from "./fixtures"
import { modelVariantCycleSelector } from "./selectors"

test("smoke model variant cycle updates label", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.addStyleTag({
    content: `${modelVariantCycleSelector} { display: inline-block !important; }`,
  })

  const button = page.locator(modelVariantCycleSelector)
  const exists = (await button.count()) > 0
  test.skip(!exists, "current model has no variants")
  if (!exists) return

  await expect(button).toBeVisible()

  const before = (await button.innerText()).trim()
  const options = page.locator('[data-slot="select-select-item"]')

  const chooseDifferent = async (current: string) => {
    await button.click()
    await expect(options.first()).toBeVisible()
    const values = await options.allTextContents()
    const index = values.findIndex((value) => value.trim() !== current)
    if (index < 0) throw new Error("model variant control has no alternative option")
    await options.nth(index).click()
  }

  await chooseDifferent(before)
  await expect(button).not.toHaveText(before)

  const after = (await button.innerText()).trim()
  await chooseDifferent(after)
  await expect(button).not.toHaveText(after)
})
