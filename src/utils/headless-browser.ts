/**
 * Whether the browser holding a page runs headless, so a reply can say no
 * window shows it. Read from the browser's user agent, which carries
 * HeadlessChrome: under --headless=new the version reads plain Chrome/, and a
 * check of the version named every headless browser windowed. Undefined when
 * the browser cannot be read.
 */
export async function runsHeadless(page: any): Promise<boolean | undefined> {
  try {
    const agent = await page?.browser().userAgent();
    return typeof agent === 'string' ? agent.includes('HeadlessChrome') : undefined;
  } catch {
    return undefined;
  }
}
