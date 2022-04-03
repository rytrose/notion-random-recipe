const dotenv = require("dotenv");
const { Client } = require("@notionhq/client");

dotenv.config({ path: `${__dirname}/.env` });
const notion = new Client({ auth: process.env.NOTION_KEY });

const RECIPIES_DATABASE_ID = process.env.RECIPIES_DATABASE_ID;
const TRIGGER_BLOCK_ID = process.env.TRIGGER_BLOCK_ID;
const SELECTION_BLOCK_ID = process.env.SELECTION_BLOCK_ID;

const CACHE_DURATION = 1000 * 60 * 5;
let lastUpdatedRecipes = undefined;
let recipesCache = undefined;

class RethrownError extends Error {
  constructor(message, error) {
    super(message);
    this.name = this.constructor.name;
    if (!error) throw new Error("RethrownError requires a message and error");
    this.original_error = error;
    this.stack_before_rethrow = this.stack;
    const message_lines = (this.message.match(/\n/g) || []).length + 1;
    this.stack =
      this.stack
        .split("\n")
        .slice(0, message_lines + 1)
        .join("\n") +
      "\n" +
      error.stack;
  }
}

async function main() {
  while (true) {
    await pollRandomRecipe();
  }
}

async function pollRandomRecipe() {
  try {
    const { triggered, triggerBlock } = await checkTrigger();
    if (triggered) {
      const triggerLabel = await setTriggerProcessing(triggerBlock);
      const selectionBlock = await getSelection();
      const selectedRecipeID = await checkSelectionForRecipe(selectionBlock);
      const recipes = await getRecipes();
      const filteredRecipes = recipes.filter((r) => r.id != selectedRecipeID);
      const recipeIndex = Math.floor(Math.random() * filteredRecipes.length);
      const recipe = filteredRecipes[recipeIndex];
      await setSelection(recipe);
      await resetTrigger(triggerBlock, triggerLabel);
    }
  } catch (error) {
    console.error(error);
  }
}

async function checkTrigger() {
  try {
    const trigger = await notion.blocks.retrieve({
      block_id: TRIGGER_BLOCK_ID,
    });
    return {
      triggered: trigger.to_do.checked,
      triggerBlock: trigger,
    };
  } catch (error) {
    throw new RethrownError("Unable to fetch trigger", error);
  }
}

async function setTriggerProcessing(block) {
  try {
    let triggerLabel = block.to_do.text.reduce((l, t) => l + t.plain_text, "");
    await notion.blocks.update({
      block_id: block.id,
      to_do: {
        text: [
          {
            text: {
              content:
                triggerLabel +
                " (choosing random recipe, will uncheck when finished...)",
            },
          },
        ],
      },
    });
    return triggerLabel;
  } catch (error) {
    throw new RethrownError("Unable to update trigger block", error);
  }
}

async function getSelection() {
  try {
    return await notion.blocks.retrieve({
      block_id: SELECTION_BLOCK_ID,
    });
  } catch (error) {
    throw new RethrownError("Unable to get selection block", error);
  }
}

async function checkSelectionForRecipe(selection) {
  const text = selection?.paragraph?.text;
  if (!text) return;
  for (let richText of text) {
    const page = richText?.mention?.page;
    if (page) return page.id;
  }
}

async function getRecipes() {
  if (Date.now() - lastUpdatedRecipes < CACHE_DURATION) {
    return recipesCache;
  }
  const recipes = await fetchRecipes();
  recipesCache = recipes;
  lastUpdatedRecipes = Date.now();
  return recipes
}

async function fetchRecipes() {
  const recipes = [];
  let cursor = undefined;

  while (true) {
    try {
      const { results, next_cursor } = await notion.databases.query({
        database_id: RECIPIES_DATABASE_ID,
        start_cursor: cursor,
      });
      recipes.push(...results);
      if (!next_cursor) {
        break;
      }
      cursor = next_cursor;
    } catch (error) {
      throw new RethrownError("Unable to fetch recipes", error);
    }
  }

  return recipes;
}

async function setSelection(recipe) {
  try {
    const selection = await notion.blocks.retrieve({
      block_id: SELECTION_BLOCK_ID,
    });

    await notion.blocks.update({
      block_id: selection.id,
      paragraph: {
        rich_text: [
          {
            mention: {
              page: {
                id: recipe.id,
              },
            },
          },
        ],
      },
    });
  } catch (error) {
    throw new RethrownError("Unable to set selection", error);
  }
}

async function resetTrigger(trigger, label) {
  try {
    await notion.blocks.update({
      block_id: trigger.id,
      to_do: {
        checked: false,
        text: [{ text: { content: label } }],
      },
    });
  } catch (error) {
    throw new RethrownError("Unable to reset trigger", error);
  }
}

main();
