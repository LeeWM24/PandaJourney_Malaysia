## Coding Standards (TBC)
### General Standards

- Follow consistent naming conventions throughout the project.
- Use English for all source code, variables, functions, comments, and documentation.
- Ensure all source code is properly indented.
- Keep functions focused on a single responsibility.
- Add comments only for complex business logic or external API integrations.
- Perform code reviews before merging changes into the `main` branch.
- Avoid duplicate code.
- Validate all user inputs.
- Ensure all APIs return standardized responses.

### Architecture Standards

The project follows a Modular Layered Architecture consisting of four layers:

1. Presentation Layer
   - Responsible for UI rendering and user interactions.
   
2. Controller Layer
   - Handles requests and coordinates module operations.

3. Business Logic Layer
   - Implements business rules, calculations, and validations.

4. Data & Integration Layer
   - Handles database operations and external API integrations.

### Naming Convention

| Element          | Convention        | Example                        |
|------------------|-------------------|----------------------------    |
| Variables        | camelCase         | `userName`, `travelPreference` |
| Functions        | camelCase         | `generateItinerary()`          |
| Classes          | PascalCase        | `UserController`               |
| Components       | PascalCase        | `ProfileCard`                  |
| Database Tables  | snake_case        | `user_profile`                 |
| API Endpoints    | kebab-case        | `/api/user-profile`            |
| Constants        | UPPER_SNAKE_CASE  | `MAX_LOGIN_ATTEMPTS`           |
| Files            | kebab-case        | `user-profile.js`              |



# PandaJourney Malaysia

PandaJourney Malaysia is a smart tourism planning prototype for Malaysia travel.  
The system helps users generate a travel itinerary based on start location, end location, travel date, start time, available travelling hours, travel interests and minimum rating.

## Teammate Local Setup

Some files are intentionally not uploaded to GitHub because they contain private keys. Each teammate must create these files locally on their own device.

Private files that must stay local:

- `PandaJourney_Malaysia/.env`
- `PandaJourney_Malaysia/firebase_key.json`

Do not commit or upload those files to GitHub. The repo includes `PandaJourney_Malaysia/.env.example` as a safe template with placeholder values.

Setup commands from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r PandaJourney_Malaysia\requirements.txt
Copy-Item PandaJourney_Malaysia\.env.example PandaJourney_Malaysia\.env
```

After copying, open `PandaJourney_Malaysia/.env` and fill in the real values.

For Firebase mode, place the Firebase service account key here:

```text
PandaJourney_Malaysia/firebase_key.json
```

Then make sure `.env` has:

```env
USE_FIREBASE=true
FIREBASE_PROJECT_ID=pandajourney-ef50a
GOOGLE_APPLICATION_CREDENTIALS=firebase_key.json
FIREBASE_USE_REST=true
```

If a teammate does not have the Firebase key yet, they can still run the app with local JSON fallback:

```env
USE_FIREBASE=false
```

In fallback mode, saved itineraries and collaboration data are stored locally in `PandaJourney_Malaysia/data/`, so they will not see the shared Firebase database.

Run the app:

```powershell
cd PandaJourney_Malaysia
python app.py
```

Open:

```text
http://127.0.0.1:5001
```

Firebase health check:

```text
http://127.0.0.1:5001/health/firebase
```

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

After activating the virtual environment, install the required Python packages: 
```text
pip install -r requirements.txt
```
If requirements.txt is missing, install manually: 
```text
pip install flask requests python-dotenv
```
## 4. Environment File Setup

Create a .env file in the project root folder.

You can copy from .env.example:
```text
SERPAPI_KEY=your_serpapi_key_here
NOMINATIM_EMAIL=your_email@example.com
NOMINATIM_USER_AGENT=PandaJourneyMalaysia/1.0 (your_email@example.com)
```
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
```text
app.py
services.py
templates/
static/css/app.css
data/demo_attractions.json
```

## 7. Common Problems
ModuleNotFoundError: No module named 'flask'

pip install flask requests python-dotenv
