# Unfixed home-overview extraction

The old HomeFeed full `jobs.list({})` read and HomeModel/Fleet counter loops
were moved behind the new typed overview endpoint without bounding the read.
The endpoint still calls the original full repository list and returns every
historical job. Existing UI behavior on healthy data is preserved. This is the
actual unfixed read algorithm exposed through a testable service interface.
