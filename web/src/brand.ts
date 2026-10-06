// The product's name and voice in one place, so copy across the app stays consistent.
export type Brand = {
  name: string
  /** Wordmark split: `lead` in mint, `tail` in coral. */
  lead: string
  tail: string
  tagline: string
  /** Short line for meta tags and the footer. */
  pitch: string
}

export const BRAND: Brand = {
  name: 'YayNay',
  lead: 'Yay',
  tail: 'Nay',
  tagline: 'Yay or nay?',
  pitch: 'Call what happens next with your USDC on Arc.',
}
