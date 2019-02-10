# Figma Range Sync

This script scans [Figma](https://figma.com/) for recently edited design files,
and uploads the changes to [Range](https://www.range.co/) so that it's easy
to share your design work with your cross-functional team.

This is fun weekend project, and not yet a robust stable integration between
the two services.

## Setup

Install dependencies
`$ npm install`

Edit your [conf.yaml](conf.yaml) file to include:

- Your Figma personal access token and teamID
- A Range Webhook URL to send events to
- A list of Names and Email addresses for accounts to sync

## Running the service

When you're ready to start the syncing service, simply run:
`$ npm start`

By default, this service will continue running, and will sync changes
every 10 minutes.
