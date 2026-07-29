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
   - 
2. Controller Layer
   - Handles requests and coordinates module operations.

3. Business Logic Layer
   - Implements business rules, calculations, and validations.

4. Data & Integration Layer
   - Handles database operations and external API integrations.

### Naming Conventions
Convention: camelCase
Example   : userName

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

### Folder Structure

```text
src/
├── presentation/
├── controllers/
├── services/
├── repositories/
├── models/
├── integrations/
├── utils/
└── tests/

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
