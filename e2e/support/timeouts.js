// Cucumber global step timeout.
//
// The default is 5s per step, which is far too tight for a Selenium suite
// against a dev server: the first page load triggers on-demand compilation
// (10-20s), and several steps legitimately chain 10s waits (login outcome,
// board hydration, walking member cards). 90s leaves headroom for the
// slowest step (the lockout scenario: 5 sequential sign-ins) without
// masking genuine hangs.
const { setDefaultTimeout } = require("@cucumber/cucumber");

setDefaultTimeout(90 * 1000);
