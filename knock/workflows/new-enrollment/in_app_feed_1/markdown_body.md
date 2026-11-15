{% if total_actors > 1 %}**{{ total_actors }} new Students** enrolled{% else %}**{{ actors[0].name | escape }}** enrolled{% endif %} on **{{ data.course_title | escape }}**.
