// Browser stand-in for the optional `sentiment` package (AFINN-165), which is Node-only.
//
// Throwing during evaluation is the point: src/checks/sentiment.js wraps its import in a try/catch and turns a
// failure into the message a reader should see, so the browser gets that same message rather than a bundle
// carrying a Node lexicon it cannot use. The page's own sentiment options are the built-in lexicon and an HTTP
// service, both of which work here.
throw new Error('AFINN analyzer needs the `sentiment` package: npm install sentiment');
