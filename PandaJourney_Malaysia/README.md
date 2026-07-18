# PandaJourney Malaysia

PandaJourney Malaysia is a smart tourism planning prototype for Malaysia travel.  
The system helps users generate a travel itinerary based on start location, end location, travel date, start time, available travelling hours, travel interests and minimum rating.

The current prototype includes:

- Smart Itinerary Planning
- Weather-aware attraction recommendation
- Route calculation
- Itinerary timetable generation
- Interactive route map
- Waze navigation link

---

## 1. Project Setup

After downloading or cloning the project from GitHub, open the project folder in VS Code.

Example project folder:

```text
PandaJourney_Malaysia/
│
├── app.py
├── services.py
├── requirements.txt
├── .env.example
├── templates/
├── static/
└── data/


```
## 2. Create Virtual Environment

Open Terminal / PowerShell in the project folder.

Run: python -m venv .venv

Activate the virtual environment:  .\.venv\Scripts\activate

If successful, the terminal should show: If successful, the terminal should show:(.venv)


## 3. Install Required Packages

After activating the virtual environment, install the required Python packages: pip install -r requirements.txt

If requirements.txt is missing, install manually: pip install flask requests python-dotenv

## 4. Environment File Setup

Create a .env file in the project root folder.

You can copy from .env.example:

SERPAPI_KEY=your_serpapi_key_here
NOMINATIM_EMAIL=your_email@example.com
NOMINATIM_USER_AGENT=PandaJourneyMalaysia/1.0 (your_email@example.com)

## 5. Run the Flask Application

Make sure the virtual environment is activated.

Run: python app.py

If successful, the terminal will show: Running on http://127.0.0.1:5000

9. GitHub Collaboration Guide
1. Open GitHub Desktop
2. Select the project repository
3. Click Fetch Origin
4. Click Pull Origin if updates are available
5. Edit the code
6. Test the system
7. Write a clear commit message
8. Commit changes
9. Push Origin



## 6. Important Files

app.py
services.py
templates/
static/css/app.css
data/demo_attractions.json


## 7. Common Problems
ModuleNotFoundError: No module named 'flask'

pip install flask requests python-dotenv