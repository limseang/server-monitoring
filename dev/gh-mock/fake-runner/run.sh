#!/bin/sh
# Stand-in for the runner's run.sh: just stays alive (the test runs the deploy commands itself).
echo "fake runner listening as $(id -un)"
while true; do sleep 30; done
