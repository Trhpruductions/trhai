// What every installed copy is built with for the paywall. Owner-edited.
//
// licensePublicKeyBase64: the public half of the owner's license signing key
// (Ed25519, SPKI, base64). Copies check keys against it offline; it cannot
// issue anything. The private half lives only on the owner's PC - see
// scripts/licensing/keygen.mjs.
//
// checkoutUrl / priceText: where the "Buy a license" button goes and what it
// says, for every copy. A hosted checkout page (Stripe Payment Link, Lemon
// Squeezy, Gumroad, PayPal...) that the buyer pays on in their browser; the
// owner then sends the key. null leaves the button out and says to ask for a
// key instead.
//
// Each has an environment override, read at run time: TRHAI_LICENSE_PUBLIC_KEY
// (the tests sign with their own), TRHAI_CHECKOUT_URL, TRHAI_PRICE_TEXT.
export const licensePublicKeyBase64 = "MCowBQYDK2VwAyEAJm8FFhwq7P50zHJ+RJjFIcdu9iX0zyJsAECduST5tUs=";
export const checkoutUrl: string | null = null;
export const priceText: string | null = null;
