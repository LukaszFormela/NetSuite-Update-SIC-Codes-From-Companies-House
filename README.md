# NetSuite-Update-SIC-Codes-From-Companies-House
## About the project
This is a single Map/Reduce file that can be scheduled as frequent as every 15 minutes.
API calls to Companies House have a limit of 600 calls per 5 minutes, which limit this code is aware of.

Apart from calling the Companies House API, script does some basic sanitizing and updates relevant fields on Customer records.
