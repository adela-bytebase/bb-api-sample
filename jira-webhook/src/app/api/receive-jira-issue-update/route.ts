import { generateToken, fetchData, createIssueWorkflow } from '../utils';

interface JiraWebhookPayload {
  webhookEvent: string;
  issue_event_type_name: string;
  issue: {
    key: string;
    fields: {
      issuetype: {
        name: string;
      };
      project: {
        key: string;
      };
      summary: string;
      description: string;
      customfield_10038: string; // SQL statement
      customfield_10040: string; // Database name
      customfield_10039: string; // Bytebase issue link
      status: {
        name: string;
      };
    };
  };
}

interface ParsedData {
  issueKey: string;
  issueType: string;
  projectKey: string;
  summary: string;
  description: string;
  sqlStatement: string;
  database: string;
  status: string;
  bytebaseIssueLink: string;
}

interface BytebaseProject {
  key: string;
  name: string;
}

// Declare the global variable
declare global {
  // eslint-disable-next-line no-var
  var lastJiraWebhook: ParsedData | null;
}

export async function POST(request: Request) {
    console.log(`${request.method} request received`, request);

    try {
        const body: JiraWebhookPayload = await request.json();
        console.log('Received payload:', JSON.stringify(body));

        const issueType = body.issue.fields.issuetype.name;
        if (issueType !== 'Database Change') {
            return Response.json({ error: 'Not a Database Change issue' }, { status: 400 });
        }

        const issueKey = body.issue.key;
        const projectKey = body.issue.fields.project.key;
        const summary = body.issue.fields.summary;
        const description = body.issue.fields.description;
        const sqlStatement = body.issue.fields.customfield_10038;
        const database = body.issue.fields.customfield_10040;
        const status = body.issue.fields.status.name;
        let bytebaseIssueLink = body.issue.fields.customfield_10039;

        const parsedData: ParsedData = {
            issueKey,
            issueType,
            projectKey,
            summary,
            description,
            sqlStatement,
            database,
            status,
            bytebaseIssueLink,
        };

        // Check if this is a new issue creation
        if (body.webhookEvent === "jira:issue_created" && body.issue_event_type_name === "issue_created") {
            // Create Bytebase issue
            const token = await generateToken();
            const allProjectData = await fetchData(`${process.env.NEXT_PUBLIC_BB_HOST}/v1/projects`, token);

            console.log("=============allProjectData", allProjectData);
            
            // Find matching Bytebase project
            const matchingProject = allProjectData.projects.find((project: BytebaseProject) => project.key === projectKey);
            if (!matchingProject) {
                return Response.json({ error: 'No matching Bytebase project found' }, { status: 400 });
            }

            console.log("=============matchingProject", matchingProject);
            // Fetch databases for the matching project
            const databasesData = await fetchData(`${process.env.NEXT_PUBLIC_BB_HOST}/v1/${matchingProject.name}/databases`, token);

            console.log("=============databasesData", databasesData);
            
            // Find matching database
            const matchingDatabase = databasesData.databases.find((db: { name: string }) => db.name.split('/').pop() === database);
            if (!matchingDatabase) {
                return Response.json({ error: 'No matching Bytebase database found' }, { status: 400 });
            }

            console.log("=============matchingDatabase", matchingDatabase);

            // Create Bytebase issue
            const result = await createIssueWorkflow(matchingProject.name, matchingDatabase.name, sqlStatement);
            
            if (result.success && result.issueLink) {
                bytebaseIssueLink = result.issueLink;
                parsedData.bytebaseIssueLink = bytebaseIssueLink;

                // Update Jira issue with Bytebase link
                const jiraApiUrl = `https://bytebase.atlassian.net/rest/api/3/issue/${issueKey}`;
                const jiraAuth = Buffer.from(
                  `${process.env.NEXT_PUBLIC_JIRA_EMAIL}:${process.env.NEXT_PUBLIC_JIRA_API_TOKEN}`
                ).toString('base64');

                await fetch(jiraApiUrl, {
                  method: 'PUT',
                  headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${jiraAuth}`,
                  },
                  body: JSON.stringify({
                    fields: {
                      customfield_10039: bytebaseIssueLink
                    }
                  }),
                });
            } else {
                return Response.json({ error: 'Failed to create Bytebase issue', details: result.message }, { status: 500 });
            }
        }

        // Store the parsed data in a global variable
        global.lastJiraWebhook = parsedData;

        return Response.json({ message: 'Webhook received and processed successfully', data: parsedData });
    } catch (error) {
        console.error('Error processing webhook:', error);
        return Response.json({ error: 'Error processing webhook' }, { status: 500 });
    }
}