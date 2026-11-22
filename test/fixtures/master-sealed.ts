/**
 * Values sealed by the server as deployed before AUTH_SECRET rotation existed (master at
 * ebd1335), with the test suite's AUTH_SECRET, "test-secret-that-is-at-least-32-characters".
 * The hosted server is live with real users, so whatever it issued then (client registrations,
 * access tokens, sign-ins in progress, codes) must still open after any change to the Sealer.
 * Never regenerate these with the current code: that would only test the code against itself.
 *
 * - clientId: a public client, redirect http://localhost:9999/callback, named "Test client".
 * - confidentialClientId / clientProof (its client_secret): a client_secret_post client with the same redirect.
 * - access (an access token): Alice's AniList token, expiring START + a year (as in test/http.test.ts).
 * - pending: the consent page's form value for clientId, cookie name suffix "golden-consent".
 * - signin: the state sent to AniList for clientId, cookie name suffix "golden-signin".
 * - code / confidentialCode: codes for Alice, verifier "verifier-0123456789-0123456789-0123456789".
 * Sign-ins expire at START + 10 minutes, codes at START + 5 minutes.
 */
export const MASTER_SEALED = {
  "clientId": "EjOVDkjoedfz1b6nGD6EOCRDepqCmFXfv5PcRbST_xaP7cdOF9s6oT_HfhD8FjT2lkUg8q_YPilTgVsIYc8QHjea5I65VRTFCR0YgzHXLJwyBWn2jpuQU7cpWq-JaybR8w",
  "confidentialClientId": "-waYlzOunkSlgvHc9BuZA1xsicMIf9JIs3HBWATQkMcvQvWfYXkNJhLIF2tKMUGzdB4JUifFU70NuO2bgKIr9yQrZYnK4bb9D_omgy2bJd0cIoaa3XSrjFL_brZj",
  "clientProof": "X1z-B-4tIDJqTbeHHRZ_Pz9abKtE7O6G_pBXZN9S89LeS8KSDaBueJgR3aArQw9Qk6R-TZ2ECnbOIQ6IkCrGGORcZPJAtkTeHJVzGNqbxQ",
  "access": "Ua2R6FrG0tNSYGzVnrJNAY8ylUPSLtds3vWvaQEMRqvFuOAXfaU5lsMIC3FskRHQ539kpvBbcvm09MbqBKCzcRg39Bhd5lxFhl0dPIsOgRZGdGA0b_nNe4A9jC-H2O7h6ti29APHoajPK8HNuGNat7dulthZsr13GajAwA",
  "pending": "i6Sp4aAkpGwfQmjTi8JKNl3VvTWlUycCWA3Oe2LX_-zHJ6-64MmTc7qQdUDgi6NPi_QTmkHVNNxRtnkCeZNUYZHg6byRGLlB4_rWYa5QGDUaQl52sax4-KeI2JzbXZ_Myke_Kyu_bvDapMYzfRkV-TGlZrWOUS2_WjwSTZA-yYGeCfcPXUW5g6UAHDXRIhjTzK0XECoNnxEjM53P489IHJEWxQh9ryv-Slf3kx_InsROQfIRbdlPioCt20jXAYPN7FbZv6lhoPWDjFVDVWoctyTNHNxk3zqtZQbTzxHGjJj_5JN3uw",
  "signin": "5JKdyFsnQKDe64KVH4Wed_OvtxCmuC1i17uLr-cmhJaPro8qKakjO7uO55YEoWxM864D_zk1AuMf0EJzdlbGmQYfT6hBKide1cNow3RVoDDXYeKrO90VhFgklvfFRIPuFQBqoA1ws6QhgMYMjg4BtfXxFcpt9hWB08KXYmoGYeCDREzJ_ndE9owRi51t7wQoZdKr9TR_KseScSJsxgVFG2nQPmVhw1Z2D_mS4ZOmPkgh_Z6W2U--QkZitCCJpMx4JrRvZExlEBEEbwp53juGdU0f6s5abo8Qr2iwhlC6kiUQB_Ce",
  "code": "5oZz1NV1POi5lliA0hhbsQ0etzY59mxy_qU5VoO3yNdjiG-_8HSb8r40sDdRElu89lPETycUweKWJnXtS-lrWDIXgG8Hafw8lOMtYy4aD_aW46pM7oeiQ4sG8G2VRaMd0jfF3Tc2VCuEMWKcYnTKVmOzp8lRaKP0id90E4ZLCDTjIsDSVvmGYtAqypEu23C8U3h_qzNSiLXOMBm-F49jTDsn150_bCMsTBmwZ6BiE6O49hSoW5tKezF7wF6wex7HeLWcVRVpRHFq7XJvZ-hYtr2wh4vIMf6NPzIwkxuMpy_OnkaDswJitCok2CIDWjeVM9-LsbwDMoCf4lb2-Vi6naA4I8S1jZPzAW9BO4tehql1A1KmpOKyt5FFcJki59ZbbutlOWAU6OsTKOomwakBwV324QPBgtZN_C033ckWonVk6CUJfMekcSUmc2JunNmfZnuZ1w",
  "confidentialCode": "RpJrUGjCGFk9z_R8dq0uWj6SXTv-h10dvPnyOU5N8zlgTofVs6BEqCmEIK0cn0Ji3BhdYI0simj1C5lZpATN1MIinaX0leRc_a7F-5nOWhpsKvESldOYEZ5leUqoNwZlH3OBKMI8t-44-IMaYjLVvwpIhs-se_lvTOYpBaRpVx2s6j2quiJ57XliOvP7CzaNncWL-tJ1vw27dT5r2uL-cf2Mb6DV6lUxefi0nii3nIkbYzXBT87DCTTLlaFGYqIPa9UkKGBraCNi7KdVmB73pOYZEOCE3Sdz0QcaxGX_-ZRRuhTqBJUI6Xti3nZC1FQRE7MR3m3PT2CS3r_K4_ODSXzqCXMFtpRnk8PglOf_bD1ohH_X60u_gkLVcyWBnKHVl61Pb672aUrFLEVAA8RA3jheEKtTq4lfmkCodJ2V1ZpcSU2I7CRYSUCIms1BS3R-sTjpToAOA_k"
} as const;
